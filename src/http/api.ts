import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import { canAddMonitor } from '../billing/entitlements.ts';
import { handleStripeEvent, type StripeEvent } from '../billing/webhook.ts';
import { verifyWebhookSignature } from '../billing/stripe.ts';
import { parseJson } from '../lib/util.ts';
import { effectivePlan } from '../plans.ts';
import type { Change } from '../schema/diff.ts';
import {
  createMonitor,
  deleteMonitor,
  getUserMonitor,
  listIncidentsForUser,
  listMonitors,
  type MonitorRow,
  type UserRow,
} from '../store.ts';
import { jsonReply, type Handler, type Reply, type Router } from './router.ts';
import { apiAuth } from './session.ts';
import { validateMonitor } from './validate.ts';

export type ApiDeps = { db: Database; config: Config };

function apiError(status: number, type: string, message: string): Reply {
  return jsonReply({ error: { type, message } }, status);
}

function serializeMonitor(monitor: MonitorRow): unknown {
  return {
    id: monitor.id,
    name: monitor.name,
    method: monitor.method,
    url: monitor.url,
    status: monitor.status,
    interval_seconds: monitor.interval_seconds,
    confirmations: monitor.confirmations,
    ignore_paths: parseJson<string[]>(monitor.ignore_paths_json, []),
    min_severity: monitor.min_severity,
    created_at: new Date(monitor.created_at).toISOString(),
    last_run_at: monitor.last_run_at === null ? null : new Date(monitor.last_run_at).toISOString(),
    baseline: {
      schema_hash: monitor.baseline_hash,
      status_code: monitor.baseline_status,
      content_type: monitor.baseline_content_type,
      learned_at: monitor.baseline_at === null ? null : new Date(monitor.baseline_at).toISOString(),
    },
    stats: {
      total_checks: monitor.total_checks,
      total_incidents: monitor.total_incidents,
      consecutive_failures: monitor.consecutive_failures,
    },
  };
}

export function registerApiRoutes(router: Router, deps: ApiDeps): void {
  const { db, config } = deps;

  /**
   * Bearer-key auth plus a plan gate. The API is a paid feature, so the check
   * lives in one place rather than in each handler.
   */
  const keyed =
    (handler: (user: UserRow, ctx: Parameters<Handler>[0]) => Promise<Reply> | Reply): Handler =>
    async (ctx) => {
      const user = apiAuth(db, ctx);
      if (!user) {
        return apiError(401, 'unauthorized', 'Provide a valid API key as a Bearer token.');
      }
      if (!effectivePlan(user.plan, user.subscription_status).apiAccess) {
        return apiError(403, 'plan_required', 'The REST API requires the Pro or Team plan.');
      }
      return handler(user, ctx);
    };

  router.get('/healthz', () => {
    const row = db.prepare('select count(*) as n from monitors').get() as { n: number };
    return jsonReply({
      ok: true,
      monitors: row.n,
      scheduler: config.scheduler.enabled,
      uptime_seconds: Math.round(process.uptime()),
    });
  });

  router.get(
    '/api/v1/monitors',
    keyed((user) => jsonReply({ data: listMonitors(db, user.id).map(serializeMonitor) })),
  );

  router.post(
    '/api/v1/monitors',
    keyed(async (user, ctx) => {
      const body = await ctx.json<Record<string, unknown>>();
      if (!body) return apiError(400, 'invalid_request', 'Body must be valid JSON.');

      const { allowed, plan, used } = canAddMonitor(db, user.id);
      if (!allowed) {
        return apiError(
          402,
          'limit_reached',
          `Your plan allows ${plan.monitors} monitors and you have ${used}.`,
        );
      }

      const validation = validateMonitor(
        {
          name: body['name'] as string,
          method: body['method'] as string,
          url: body['url'] as string,
          headers: body['headers'] as Record<string, string>,
          body: body['body'] as string,
          intervalSeconds: body['interval_seconds'] as number,
          ignorePaths: body['ignore_paths'] as string[],
          minSeverity: body['min_severity'] as string,
          confirmations: body['confirmations'] as number,
        },
        plan,
      );
      if (!validation.ok) {
        return apiError(422, 'validation_failed', validation.errors.join(' '));
      }

      const monitor = createMonitor(db, { userId: user.id, ...validation.value });
      return jsonReply({ data: serializeMonitor(monitor) }, 201);
    }),
  );

  router.get(
    '/api/v1/monitors/:id',
    keyed((user, ctx) => {
      const monitor = getUserMonitor(db, user.id, ctx.params.id ?? '');
      if (!monitor) return apiError(404, 'not_found', 'No such monitor.');
      return jsonReply({ data: serializeMonitor(monitor) });
    }),
  );

  router.delete(
    '/api/v1/monitors/:id',
    keyed((user, ctx) => {
      const id = ctx.params.id ?? '';
      if (!getUserMonitor(db, user.id, id)) return apiError(404, 'not_found', 'No such monitor.');
      deleteMonitor(db, user.id, id);
      return jsonReply({ deleted: true, id });
    }),
  );

  router.get(
    '/api/v1/incidents',
    keyed((user, ctx) => {
      const requested = Number(ctx.url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
      const severity = ctx.url.searchParams.get('severity');

      const incidents = listIncidentsForUser(db, user.id, limit).filter(
        (incident) => severity === null || incident.severity === severity,
      );

      return jsonReply({
        data: incidents.map((incident) => ({
          id: incident.id,
          monitor_id: incident.monitor_id,
          kind: incident.kind,
          severity: incident.severity,
          summary: incident.summary,
          created_at: new Date(incident.created_at).toISOString(),
          acknowledged: incident.acknowledged_at !== null,
          changes: parseJson<Change[]>(incident.changes_json, []),
        })),
      });
    }),
  );

  /**
   * Stripe webhook. Unauthenticated by design — the signature *is* the auth,
   * which is why the raw body must be read before anything parses it.
   */
  router.post('/webhooks/stripe', async (ctx) => {
    const raw = await ctx.text();
    const signature = ctx.headers['stripe-signature'];

    const verification = verifyWebhookSignature(
      raw,
      typeof signature === 'string' ? signature : null,
      config.stripe.webhookSecret,
    );
    if (!verification.ok) {
      console.warn(`[stripe] rejected webhook: ${verification.error}`);
      return apiError(400, 'invalid_signature', verification.error);
    }

    let event: StripeEvent;
    try {
      event = JSON.parse(raw) as StripeEvent;
    } catch {
      return apiError(400, 'invalid_request', 'Body was not valid JSON.');
    }

    try {
      const outcome = await handleStripeEvent(db, config, event);
      console.log(`[stripe] ${event.type}: ${outcome.detail}`);
      // Always 200 on a verified event we understood the shape of. Returning an
      // error would make Stripe retry a decision we have already recorded.
      return jsonReply({ received: true, handled: outcome.handled });
    } catch (error) {
      // A 500 here is correct: Stripe will retry, and the event id has been
      // claimed, so the retry is only useful if we clear it. Do that.
      console.error(`[stripe] handler failed for ${event.id}:`, error);
      db.prepare('delete from stripe_events where id = ?').run(event.id);
      return apiError(500, 'handler_failed', 'Event will be retried.');
    }
  });
}
