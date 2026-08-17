import type { Database } from './db.ts';
import { hashToken, newId, randomToken } from './lib/crypto.ts';
import type { Severity } from './schema/diff.ts';

export type UserRow = {
  id: string;
  email: string;
  created_at: number;
  plan: string;
  alert_min_severity: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: number | null;
  last_login_at: number | null;
};

export type MonitorRow = {
  id: string;
  user_id: string;
  name: string;
  method: string;
  url: string;
  headers_json: string;
  body: string | null;
  interval_seconds: number;
  confirmations: number;
  ignore_paths_json: string;
  min_severity: string | null;
  status: string;
  pause_reason: string | null;
  created_at: number;
  updated_at: number;
  next_run_at: number;
  last_run_at: number | null;
  last_ok_at: number | null;
  baseline_hash: string | null;
  baseline_schema_json: string | null;
  baseline_status: number | null;
  baseline_content_type: string | null;
  baseline_at: number | null;
  pending_hash: string | null;
  pending_schema_json: string | null;
  pending_status: number | null;
  pending_content_type: string | null;
  pending_count: number;
  consecutive_failures: number;
  failure_alerted: number;
  total_checks: number;
  total_incidents: number;
};

export type ChannelRow = {
  id: string;
  user_id: string;
  kind: string;
  target: string;
  secret: string | null;
  label: string;
  created_at: number;
  disabled_at: number | null;
  last_error: string | null;
};

export type IncidentRow = {
  id: string;
  monitor_id: string;
  user_id: string;
  created_at: number;
  kind: string;
  severity: string;
  summary: string;
  changes_json: string;
  from_hash: string | null;
  to_hash: string | null;
  acknowledged_at: number | null;
};

export type SnapshotRow = {
  id: string;
  monitor_id: string;
  created_at: number;
  ok: number;
  status_code: number | null;
  content_type: string | null;
  latency_ms: number | null;
  schema_hash: string | null;
  schema_json: string | null;
  error: string | null;
};

export type DeliveryRow = {
  id: string;
  incident_id: string;
  channel_id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
};

export type ApiKeyRow = {
  id: string;
  user_id: string;
  label: string;
  prefix: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------- users ------

export function findUserByEmail(db: Database, email: string): UserRow | null {
  const row = db
    .prepare('select * from users where email = ?')
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  return row ?? null;
}

export function findUserById(db: Database, id: string): UserRow | null {
  const row = db.prepare('select * from users where id = ?').get(id) as UserRow | undefined;
  return row ?? null;
}

export function findUserByStripeCustomer(db: Database, customerId: string): UserRow | null {
  const row = db.prepare('select * from users where stripe_customer_id = ?').get(customerId) as
    | UserRow
    | undefined;
  return row ?? null;
}

/**
 * Get-or-create by email. This is the whole of onboarding: a stranger typing
 * their email is a provisioned account, with no human in the loop.
 */
export function upsertUser(db: Database, email: string): UserRow {
  const normalized = email.trim().toLowerCase();
  const existing = findUserByEmail(db, normalized);
  if (existing) return existing;

  const id = newId('usr');
  db.prepare('insert into users(id, email, created_at, plan) values (?, ?, ?, ?)').run(
    id,
    normalized,
    Date.now(),
    'free',
  );
  const created = findUserById(db, id);
  if (!created) throw new Error('failed to create user');

  // Every new account gets its own email address as the default alert channel,
  // so alerts work before the customer configures anything.
  createChannel(db, created.id, 'email', normalized, 'Account email');
  return created;
}

export function setAlertMinSeverity(db: Database, userId: string, severity: Severity): void {
  db.prepare('update users set alert_min_severity = ? where id = ?').run(severity, userId);
}

export function setUserBilling(
  db: Database,
  userId: string,
  fields: {
    plan?: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: string | null;
    currentPeriodEnd?: number | null;
  },
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (fields.plan !== undefined) {
    sets.push('plan = ?');
    values.push(fields.plan);
  }
  if (fields.stripeCustomerId !== undefined) {
    sets.push('stripe_customer_id = ?');
    values.push(fields.stripeCustomerId);
  }
  if (fields.stripeSubscriptionId !== undefined) {
    sets.push('stripe_subscription_id = ?');
    values.push(fields.stripeSubscriptionId);
  }
  if (fields.subscriptionStatus !== undefined) {
    sets.push('subscription_status = ?');
    values.push(fields.subscriptionStatus);
  }
  if (fields.currentPeriodEnd !== undefined) {
    sets.push('current_period_end = ?');
    values.push(fields.currentPeriodEnd);
  }
  if (sets.length === 0) return;
  values.push(userId);
  db.prepare(`update users set ${sets.join(', ')} where id = ?`).run(...values);
}

// ------------------------------------------------------- auth / sessions -----

export function createLoginToken(db: Database, userId: string): string {
  const token = randomToken();
  const now = Date.now();
  db.prepare(
    'insert into login_tokens(token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + LOGIN_TOKEN_TTL_MS);
  return token;
}

/** Single-use: a replayed magic link is rejected even inside its TTL. */
export function consumeLoginToken(db: Database, token: string): UserRow | null {
  const hash = hashToken(token);
  const row = db.prepare('select * from login_tokens where token_hash = ?').get(hash) as
    | { user_id: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;
  db.prepare('update login_tokens set used_at = ? where token_hash = ?').run(Date.now(), hash);
  const user = findUserById(db, row.user_id);
  if (user) db.prepare('update users set last_login_at = ? where id = ?').run(Date.now(), user.id);
  return user;
}

export function createSession(db: Database, userId: string): { token: string; csrf: string } {
  const token = randomToken();
  const csrf = randomToken(24);
  const now = Date.now();
  db.prepare(
    'insert into sessions(token_hash, user_id, csrf, created_at, expires_at) values (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, csrf, now, now + SESSION_TTL_MS);
  return { token, csrf };
}

export function findSession(
  db: Database,
  token: string,
): { user: UserRow; csrf: string } | null {
  const row = db.prepare('select * from sessions where token_hash = ?').get(hashToken(token)) as
    | { user_id: string; csrf: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  const user = findUserById(db, row.user_id);
  return user ? { user, csrf: row.csrf } : null;
}

export function deleteSession(db: Database, token: string): void {
  db.prepare('delete from sessions where token_hash = ?').run(hashToken(token));
}

// ------------------------------------------------------------- api keys ------

export function createApiKey(db: Database, userId: string, label: string): { row: ApiKeyRow; token: string } {
  const secret = randomToken();
  const token = `dw_live_${secret}`;
  const id = newId('key');
  db.prepare(
    'insert into api_keys(id, user_id, label, prefix, token_hash, created_at) values (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, label || 'API key', token.slice(0, 16), hashToken(token), Date.now());
  const row = db.prepare('select * from api_keys where id = ?').get(id) as ApiKeyRow;
  return { row, token };
}

export function findUserByApiKey(db: Database, token: string): UserRow | null {
  const row = db.prepare('select * from api_keys where token_hash = ?').get(hashToken(token)) as
    | ApiKeyRow
    | undefined;
  if (!row) return null;
  db.prepare('update api_keys set last_used_at = ? where id = ?').run(Date.now(), row.id);
  return findUserById(db, row.user_id);
}

export function listApiKeys(db: Database, userId: string): ApiKeyRow[] {
  return db
    .prepare('select * from api_keys where user_id = ? order by created_at desc')
    .all(userId) as ApiKeyRow[];
}

export function deleteApiKey(db: Database, userId: string, id: string): void {
  db.prepare('delete from api_keys where id = ? and user_id = ?').run(id, userId);
}

// ------------------------------------------------------------- channels ------

export function createChannel(
  db: Database,
  userId: string,
  kind: string,
  target: string,
  label = '',
): ChannelRow {
  const id = newId('chn');
  // Webhook channels get a signing secret so receivers can verify payloads.
  const secret = kind === 'webhook' ? randomToken(24) : null;
  db.prepare(
    'insert into channels(id, user_id, kind, target, secret, label, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, kind, target, secret, label, Date.now());
  return db.prepare('select * from channels where id = ?').get(id) as ChannelRow;
}

export function listChannels(db: Database, userId: string): ChannelRow[] {
  return db
    .prepare('select * from channels where user_id = ? order by created_at')
    .all(userId) as ChannelRow[];
}

export function listActiveChannels(db: Database, userId: string): ChannelRow[] {
  return db
    .prepare('select * from channels where user_id = ? and disabled_at is null order by created_at')
    .all(userId) as ChannelRow[];
}

export function deleteChannel(db: Database, userId: string, id: string): void {
  db.prepare('delete from channels where id = ? and user_id = ?').run(id, userId);
}

export function recordChannelError(db: Database, id: string, error: string | null): void {
  db.prepare('update channels set last_error = ? where id = ?').run(error, id);
}

// ------------------------------------------------------------- monitors ------

export type NewMonitor = {
  userId: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  intervalSeconds: number;
  ignorePaths: string[];
  minSeverity: Severity | null;
  confirmations?: number;
};

export function createMonitor(db: Database, input: NewMonitor): MonitorRow {
  const id = newId('mon');
  const now = Date.now();
  db.prepare(
    `insert into monitors(
       id, user_id, name, method, url, headers_json, body, interval_seconds,
       confirmations, ignore_paths_json, min_severity, status, created_at, updated_at, next_run_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.name,
    input.method,
    input.url,
    JSON.stringify(input.headers),
    input.body,
    input.intervalSeconds,
    input.confirmations ?? 2,
    JSON.stringify(input.ignorePaths),
    input.minSeverity,
    now,
    now,
    now, // run immediately so the customer sees a baseline within seconds
  );
  return getMonitor(db, id)!;
}

export function getMonitor(db: Database, id: string): MonitorRow | null {
  const row = db.prepare('select * from monitors where id = ?').get(id) as MonitorRow | undefined;
  return row ?? null;
}

export function getUserMonitor(db: Database, userId: string, id: string): MonitorRow | null {
  const row = db.prepare('select * from monitors where id = ? and user_id = ?').get(id, userId) as
    | MonitorRow
    | undefined;
  return row ?? null;
}

export function listMonitors(db: Database, userId: string): MonitorRow[] {
  return db
    .prepare('select * from monitors where user_id = ? order by created_at desc')
    .all(userId) as MonitorRow[];
}

/**
 * Oldest first, with `id` as a tiebreaker so the order is a stable *total*
 * order. Entitlement enforcement decides which monitors to pause by position in
 * this list; ties on `created_at` (trivially common — several monitors created
 * in the same millisecond via the API) would otherwise let a monitor flap
 * between active and paused on every maintenance run.
 */
export function listMonitorsOldestFirst(db: Database, userId: string): MonitorRow[] {
  return db
    .prepare('select * from monitors where user_id = ? order by created_at asc, id asc')
    .all(userId) as MonitorRow[];
}

export function listChannelsOldestFirst(db: Database, userId: string): ChannelRow[] {
  return db
    .prepare('select * from channels where user_id = ? order by created_at asc, id asc')
    .all(userId) as ChannelRow[];
}

export function updateMonitorSettings(
  db: Database,
  userId: string,
  id: string,
  fields: {
    name?: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string | null;
    intervalSeconds?: number;
    ignorePaths?: string[];
    minSeverity?: Severity | null;
    confirmations?: number;
  },
): void {
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [Date.now()];
  const push = (sql: string, value: string | number | null) => {
    sets.push(sql);
    values.push(value);
  };
  if (fields.name !== undefined) push('name = ?', fields.name);
  if (fields.method !== undefined) push('method = ?', fields.method);
  if (fields.url !== undefined) push('url = ?', fields.url);
  if (fields.headers !== undefined) push('headers_json = ?', JSON.stringify(fields.headers));
  if (fields.body !== undefined) push('body = ?', fields.body);
  if (fields.intervalSeconds !== undefined) push('interval_seconds = ?', fields.intervalSeconds);
  if (fields.ignorePaths !== undefined) push('ignore_paths_json = ?', JSON.stringify(fields.ignorePaths));
  if (fields.minSeverity !== undefined) push('min_severity = ?', fields.minSeverity);
  if (fields.confirmations !== undefined) push('confirmations = ?', fields.confirmations);
  values.push(id, userId);
  db.prepare(`update monitors set ${sets.join(', ')} where id = ? and user_id = ?`).run(...values);
}

export function setMonitorStatus(
  db: Database,
  id: string,
  status: 'active' | 'paused',
  reason: string | null = null,
): void {
  db.prepare('update monitors set status = ?, pause_reason = ?, updated_at = ? where id = ?').run(
    status,
    reason,
    Date.now(),
    id,
  );
}

export function deleteMonitor(db: Database, userId: string, id: string): void {
  db.prepare('delete from monitors where id = ? and user_id = ?').run(id, userId);
}

/** Forget the learned shape so the next check re-baselines from scratch. */
export function resetBaseline(db: Database, userId: string, id: string): void {
  db.prepare(
    `update monitors set
       baseline_hash = null, baseline_schema_json = null, baseline_status = null,
       baseline_content_type = null, baseline_at = null,
       pending_hash = null, pending_schema_json = null, pending_status = null,
       pending_content_type = null, pending_count = 0,
       next_run_at = ?, updated_at = ?
     where id = ? and user_id = ?`,
  ).run(Date.now(), Date.now(), id, userId);
}

/**
 * Atomically claim monitors that are due and push their next run forward, so
 * an overlapping tick (or a second worker process) cannot double-probe.
 */
export function claimDueMonitors(db: Database, now: number, limit: number): MonitorRow[] {
  return db
    .prepare(
      `update monitors
          set next_run_at = ? + (interval_seconds * 1000), last_run_at = ?
        where id in (
          select id from monitors
           where status = 'active' and next_run_at <= ?
           order by next_run_at
           limit ?
        )
        returning *`,
    )
    .all(now, now, now, limit) as MonitorRow[];
}

export type MonitorPersistFields = {
  baselineHash: string | null;
  baselineSchemaJson: string | null;
  baselineStatus: number | null;
  baselineContentType: string | null;
  baselineAt: number | null;
  pendingHash: string | null;
  pendingSchemaJson: string | null;
  pendingStatus: number | null;
  pendingContentType: string | null;
  pendingCount: number;
  consecutiveFailures: number;
  failureAlerted: number;
  lastOkAt: number | null;
};

export function persistMonitorState(db: Database, id: string, state: MonitorPersistFields): void {
  db.prepare(
    `update monitors set
       baseline_hash = ?, baseline_schema_json = ?, baseline_status = ?,
       baseline_content_type = ?, baseline_at = ?,
       pending_hash = ?, pending_schema_json = ?, pending_status = ?,
       pending_content_type = ?, pending_count = ?,
       consecutive_failures = ?, failure_alerted = ?, last_ok_at = ?,
       total_checks = total_checks + 1,
       -- Set here rather than only at claim time so a manual "Check now" also
       -- refreshes it. This is the last *completed* check.
       last_run_at = ?
     where id = ?`,
  ).run(
    state.baselineHash,
    state.baselineSchemaJson,
    state.baselineStatus,
    state.baselineContentType,
    state.baselineAt,
    state.pendingHash,
    state.pendingSchemaJson,
    state.pendingStatus,
    state.pendingContentType,
    state.pendingCount,
    state.consecutiveFailures,
    state.failureAlerted,
    state.lastOkAt,
    Date.now(),
    id,
  );
}

// ------------------------------------------------------------ snapshots ------

export function insertSnapshot(
  db: Database,
  snapshot: {
    monitorId: string;
    ok: boolean;
    statusCode: number | null;
    contentType: string | null;
    latencyMs: number | null;
    schemaHash: string | null;
    schemaJson: string | null;
    error: string | null;
  },
): string {
  const id = newId('snp');
  db.prepare(
    `insert into snapshots(id, monitor_id, created_at, ok, status_code, content_type,
                           latency_ms, schema_hash, schema_json, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    snapshot.monitorId,
    Date.now(),
    snapshot.ok ? 1 : 0,
    snapshot.statusCode,
    snapshot.contentType,
    snapshot.latencyMs,
    snapshot.schemaHash,
    snapshot.schemaJson,
    snapshot.error,
  );
  return id;
}

export function listSnapshots(db: Database, monitorId: string, limit = 50): SnapshotRow[] {
  return db
    .prepare('select * from snapshots where monitor_id = ? order by created_at desc limit ?')
    .all(monitorId, limit) as SnapshotRow[];
}

/** Retention enforcement. Runs on a timer; nobody has to remember to do it. */
export function pruneSnapshots(db: Database, monitorId: string, olderThan: number): number {
  const result = db
    .prepare('delete from snapshots where monitor_id = ? and created_at < ?')
    .run(monitorId, olderThan);
  return Number(result.changes);
}

// ------------------------------------------------------------ incidents ------

export function insertIncident(
  db: Database,
  incident: {
    monitorId: string;
    userId: string;
    kind: string;
    severity: Severity;
    summary: string;
    changesJson: string;
    fromHash: string | null;
    toHash: string | null;
  },
): IncidentRow {
  const id = newId('inc');
  db.prepare(
    `insert into incidents(id, monitor_id, user_id, created_at, kind, severity, summary,
                           changes_json, from_hash, to_hash)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    incident.monitorId,
    incident.userId,
    Date.now(),
    incident.kind,
    incident.severity,
    incident.summary,
    incident.changesJson,
    incident.fromHash,
    incident.toHash,
  );
  db.prepare('update monitors set total_incidents = total_incidents + 1 where id = ?').run(
    incident.monitorId,
  );
  return db.prepare('select * from incidents where id = ?').get(id) as IncidentRow;
}

export function getIncident(db: Database, userId: string, id: string): IncidentRow | null {
  const row = db.prepare('select * from incidents where id = ? and user_id = ?').get(id, userId) as
    | IncidentRow
    | undefined;
  return row ?? null;
}

export function listIncidentsForUser(db: Database, userId: string, limit = 50): IncidentRow[] {
  return db
    .prepare('select * from incidents where user_id = ? order by created_at desc limit ?')
    .all(userId, limit) as IncidentRow[];
}

/**
 * Aggregate counts for the dashboard. Counting a capped page of rows in JS
 * instead would silently understate any account busy enough to exceed the page
 * size — the exact accounts whose numbers matter most.
 */
export function countIncidentsSince(
  db: Database,
  userId: string,
  since: number,
): { total: number; breaking: number } {
  const row = db
    .prepare(
      `select count(*) as total,
              sum(case when severity = 'breaking' then 1 else 0 end) as breaking
         from incidents where user_id = ? and created_at > ?`,
    )
    .get(userId, since) as { total: number; breaking: number | null };
  return { total: row.total, breaking: row.breaking ?? 0 };
}

export function listIncidentsForMonitor(db: Database, monitorId: string, limit = 50): IncidentRow[] {
  return db
    .prepare('select * from incidents where monitor_id = ? order by created_at desc limit ?')
    .all(monitorId, limit) as IncidentRow[];
}

export function acknowledgeIncident(db: Database, userId: string, id: string): void {
  db.prepare('update incidents set acknowledged_at = ? where id = ? and user_id = ?').run(
    Date.now(),
    id,
    userId,
  );
}

// ----------------------------------------------------------- deliveries ------

export function enqueueDeliveries(db: Database, incidentId: string, channelIds: string[]): void {
  const stmt = db.prepare(
    `insert into deliveries(id, incident_id, channel_id, status, next_attempt_at, created_at)
     values (?, ?, ?, 'pending', ?, ?)`,
  );
  const now = Date.now();
  for (const channelId of channelIds) {
    stmt.run(newId('dlv'), incidentId, channelId, now, now);
  }
}

export function claimPendingDeliveries(db: Database, now: number, limit: number): DeliveryRow[] {
  return db
    .prepare(
      `update deliveries
          set attempts = attempts + 1, next_attempt_at = ?
        where id in (
          select id from deliveries
           where status = 'pending' and next_attempt_at <= ?
           order by next_attempt_at
           limit ?
        )
        returning *`,
    )
    // Park the row 10 minutes out while we attempt it; a real failure will
    // reschedule it precisely, and a crash mid-send retries instead of stalling.
    .all(now + 600_000, now, limit) as DeliveryRow[];
}

export function markDeliverySent(db: Database, id: string): void {
  db.prepare("update deliveries set status = 'sent', sent_at = ?, last_error = null where id = ?").run(
    Date.now(),
    id,
  );
}

export function markDeliveryFailed(
  db: Database,
  id: string,
  error: string,
  retryAt: number | null,
): void {
  if (retryAt === null) {
    db.prepare("update deliveries set status = 'failed', last_error = ? where id = ?").run(error, id);
  } else {
    db.prepare(
      "update deliveries set status = 'pending', last_error = ?, next_attempt_at = ? where id = ?",
    ).run(error, retryAt, id);
  }
}

export function getDeliveryContext(
  db: Database,
  delivery: DeliveryRow,
): { incident: IncidentRow; channel: ChannelRow; monitor: MonitorRow } | null {
  const incident = db.prepare('select * from incidents where id = ?').get(delivery.incident_id) as
    | IncidentRow
    | undefined;
  const channel = db.prepare('select * from channels where id = ?').get(delivery.channel_id) as
    | ChannelRow
    | undefined;
  if (!incident || !channel) return null;
  const monitor = getMonitor(db, incident.monitor_id);
  if (!monitor) return null;
  return { incident, channel, monitor };
}

// -------------------------------------------------------- stripe events ------

/**
 * Returns false when the event was already handled (Stripe retries a lot).
 *
 * Only a primary-key collision counts as "already handled". Treating *any*
 * failure as a duplicate would silently discard billing events whenever the
 * database was momentarily busy, which is how a paying customer ends up stuck
 * on the free plan with no trace of why.
 */
export function claimStripeEvent(db: Database, id: string, type: string): boolean {
  try {
    db.prepare('insert into stripe_events(id, type, received_at) values (?, ?, ?)').run(
      id,
      type,
      Date.now(),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(message)) return false;
    throw error;
  }
}

// ------------------------------------------------------------ janitorial -----

/**
 * Erase an account and everything belonging to it.
 *
 * Every table referencing `users` does so with `on delete cascade`, and foreign
 * keys are enabled on the connection, so this single delete removes monitors,
 * snapshots, incidents, deliveries, channels, API keys, sessions and login
 * tokens. Anyone taking money needs a real erasure path, not a support ticket.
 */
export function deleteUser(db: Database, userId: string): void {
  db.prepare('delete from users where id = ?').run(userId);
}

export function pruneExpired(db: Database): void {
  const now = Date.now();
  db.prepare('delete from sessions where expires_at < ?').run(now);
  db.prepare('delete from login_tokens where expires_at < ?').run(now - 86_400_000);
  db.prepare('delete from stripe_events where received_at < ?').run(now - 30 * 86_400_000);
}

export function listUserIdsWithMonitors(db: Database): string[] {
  const rows = db.prepare('select distinct user_id as id from monitors').all() as { id: string }[];
  return rows.map((row) => row.id);
}
