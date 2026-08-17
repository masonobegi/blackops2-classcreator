import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import { getMeta, setMeta } from '../db.ts';
import { applyEntitlements } from '../billing/entitlements.ts';
import { mapLimit, parseJson } from '../lib/util.ts';
import { queueIncidentNotifications, runDeliveryQueue } from '../notify/dispatch.ts';
import { effectivePlan } from '../plans.ts';
import type { Severity } from '../schema/diff.ts';
import type { SchemaNode } from '../schema/infer.ts';
import {
  claimDueMonitors,
  findUserById,
  insertIncident,
  insertSnapshot,
  listMonitors,
  listUserIdsWithMonitors,
  persistMonitorState,
  pruneExpired,
  pruneSnapshots,
  type MonitorRow,
} from '../store.ts';
import { evaluate, type EvalState } from './evaluate.ts';
import { probe } from './probe.ts';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const MAINTENANCE_KEY = 'last_maintenance_at';

export type TickResult = {
  checked: number;
  incidents: number;
  sent: number;
  failed: number;
  retrying: number;
};

export type Scheduler = {
  start: () => void;
  stop: () => void;
  tick: () => Promise<TickResult>;
  runMonitorNow: (monitorId: string) => Promise<void>;
};

function stateFromRow(row: MonitorRow): EvalState {
  return {
    baselineHash: row.baseline_hash,
    baselineSchema: parseJson<SchemaNode | null>(row.baseline_schema_json, null),
    baselineStatus: row.baseline_status,
    baselineContentType: row.baseline_content_type,
    baselineAt: row.baseline_at,
    pendingHash: row.pending_hash,
    pendingSchema: parseJson<SchemaNode | null>(row.pending_schema_json, null),
    pendingStatus: row.pending_status,
    pendingContentType: row.pending_content_type,
    pendingCount: row.pending_count,
    consecutiveFailures: row.consecutive_failures,
    failureAlerted: row.failure_alerted === 1,
    lastOkAt: row.last_ok_at,
  };
}

export function createScheduler(db: Database, config: Config): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  /** Probe one monitor and persist everything that follows from the result. */
  async function checkMonitor(monitor: MonitorRow): Promise<boolean> {
    const previous = stateFromRow(monitor);

    const outcome = await probe(
      {
        method: monitor.method,
        url: monitor.url,
        headers: parseJson<Record<string, string>>(monitor.headers_json, {}),
        body: monitor.body,
      },
      {
        timeoutMs: config.probe.timeoutMs,
        maxBytes: config.probe.maxBytes,
        allowPrivateTargets: config.probe.allowPrivateTargets,
      },
    );

    const result = evaluate(previous, outcome, {
      ignorePaths: parseJson<string[]>(monitor.ignore_paths_json, []),
      confirmations: monitor.confirmations,
      failureThreshold: FAILURE_THRESHOLD,
      now: Date.now(),
    });

    insertSnapshot(db, {
      monitorId: monitor.id,
      ok: outcome.ok,
      statusCode: outcome.status,
      contentType: outcome.contentType,
      latencyMs: outcome.latencyMs,
      schemaHash: result.schemaHash,
      schemaJson: result.schemaJson,
      error: outcome.ok ? null : outcome.error,
    });

    persistMonitorState(db, monitor.id, {
      baselineHash: result.state.baselineHash,
      baselineSchemaJson: result.state.baselineSchema
        ? JSON.stringify(result.state.baselineSchema)
        : null,
      baselineStatus: result.state.baselineStatus,
      baselineContentType: result.state.baselineContentType,
      baselineAt: result.state.baselineAt,
      pendingHash: result.state.pendingHash,
      pendingSchemaJson: result.state.pendingSchema
        ? JSON.stringify(result.state.pendingSchema)
        : null,
      pendingStatus: result.state.pendingStatus,
      pendingContentType: result.state.pendingContentType,
      pendingCount: result.state.pendingCount,
      consecutiveFailures: result.state.consecutiveFailures,
      failureAlerted: result.state.failureAlerted ? 1 : 0,
      lastOkAt: result.state.lastOkAt,
    });

    if (!result.incident) return false;

    const user = findUserById(db, monitor.user_id);
    if (!user) return false;

    const incident = insertIncident(db, {
      monitorId: monitor.id,
      userId: monitor.user_id,
      kind: result.incident.kind,
      severity: result.incident.severity as Severity,
      summary: result.incident.summary,
      changesJson: JSON.stringify(result.incident.changes),
      fromHash: result.incident.fromHash,
      toHash: result.incident.toHash,
    });

    queueIncidentNotifications(db, incident, monitor, user);
    console.log(
      `[monitor] ${monitor.id} ${monitor.name}: ${result.incident.severity} — ${result.incident.summary}`,
    );
    return true;
  }

  async function tick(): Promise<TickResult> {
    const now = Date.now();
    // Claim a little more than one round of work so a burst of due monitors
    // drains over consecutive ticks instead of piling up.
    const due = claimDueMonitors(db, now, config.scheduler.concurrency * 4);

    let incidents = 0;
    if (due.length > 0) {
      const raised = await mapLimit(due, config.scheduler.concurrency, async (monitor) => {
        try {
          return await checkMonitor(monitor);
        } catch (error) {
          // One bad monitor must never take the loop down.
          console.error(`[monitor] ${monitor.id} check threw:`, error);
          return false;
        }
      });
      incidents = raised.filter(Boolean).length;
    }

    const delivery = await runDeliveryQueue(db, config);
    maybeRunMaintenance();

    return {
      checked: due.length,
      incidents,
      sent: delivery.sent,
      failed: delivery.failed,
      retrying: delivery.retrying,
    };
  }

  /**
   * Hourly housekeeping: enforce retention, expire sessions, and re-apply plan
   * entitlements. The last one is a safety net — billing webhooks already do it,
   * but a webhook that was missed during a deploy would otherwise leave a
   * cancelled customer on a paid plan indefinitely.
   */
  function maybeRunMaintenance(): void {
    const last = Number(getMeta(db, MAINTENANCE_KEY) ?? '0');
    if (Date.now() - last < MAINTENANCE_INTERVAL_MS) return;
    setMeta(db, MAINTENANCE_KEY, String(Date.now()));

    try {
      pruneExpired(db);
      for (const userId of listUserIdsWithMonitors(db)) {
        const user = findUserById(db, userId);
        if (!user) continue;
        const plan = effectivePlan(user.plan, user.subscription_status);
        const cutoff = Date.now() - plan.historyDays * 86_400_000;
        for (const monitor of listMonitors(db, userId)) {
          pruneSnapshots(db, monitor.id, cutoff);
        }
        applyEntitlements(db, userId);
      }
      console.log('[scheduler] maintenance complete');
    } catch (error) {
      console.error('[scheduler] maintenance failed:', error);
    }
  }

  return {
    start(): void {
      if (timer) return;
      const run = async () => {
        // Ticks never overlap: a slow round is skipped rather than stacked.
        if (running) return;
        running = true;
        try {
          const result = await tick();
          if (result.checked > 0 || result.sent > 0 || result.failed > 0) {
            console.log(
              `[scheduler] checked=${result.checked} incidents=${result.incidents} sent=${result.sent} retrying=${result.retrying} failed=${result.failed}`,
            );
          }
        } catch (error) {
          console.error('[scheduler] tick failed:', error);
        } finally {
          running = false;
        }
      };
      timer = setInterval(run, config.scheduler.tickMs);
      void run();
      console.log(`[scheduler] started, tick every ${config.scheduler.tickMs}ms`);
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    tick,

    async runMonitorNow(monitorId: string): Promise<void> {
      const row = db.prepare('select * from monitors where id = ?').get(monitorId) as
        | MonitorRow
        | undefined;
      if (!row) return;
      await checkMonitor(row);
      await runDeliveryQueue(db, config);
    },
  };
}
