import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Database = DatabaseSync;

/**
 * Schema migrations, applied in order and tracked with `pragma user_version`.
 * Append-only: never edit a shipped migration, add a new one.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  create table users (
    id                     text primary key,
    email                  text not null unique,
    created_at             integer not null,
    plan                   text not null default 'free',
    alert_min_severity     text not null default 'warning',
    stripe_customer_id     text,
    stripe_subscription_id text,
    subscription_status    text,
    current_period_end     integer,
    last_login_at          integer
  );

  create table login_tokens (
    token_hash text primary key,
    user_id    text not null references users(id) on delete cascade,
    created_at integer not null,
    expires_at integer not null,
    used_at    integer
  );

  create table sessions (
    token_hash text primary key,
    user_id    text not null references users(id) on delete cascade,
    csrf       text not null,
    created_at integer not null,
    expires_at integer not null
  );

  create table api_keys (
    id           text primary key,
    user_id      text not null references users(id) on delete cascade,
    label        text not null,
    prefix       text not null,
    token_hash   text not null unique,
    created_at   integer not null,
    last_used_at integer
  );

  create table channels (
    id          text primary key,
    user_id     text not null references users(id) on delete cascade,
    kind        text not null,              -- email | slack | webhook
    target      text not null,              -- address or URL
    secret      text,                       -- HMAC key for webhook signing
    label       text not null default '',
    created_at  integer not null,
    disabled_at integer,
    last_error  text
  );

  create table monitors (
    id                    text primary key,
    user_id               text not null references users(id) on delete cascade,
    name                  text not null,
    method                text not null default 'GET',
    url                   text not null,
    headers_json          text not null default '{}',
    body                  text,
    interval_seconds      integer not null,
    confirmations         integer not null default 2,
    ignore_paths_json     text not null default '[]',
    min_severity          text,             -- null = inherit account default
    status                text not null default 'active',  -- active | paused
    pause_reason          text,
    created_at            integer not null,
    updated_at            integer not null,
    next_run_at           integer not null,
    last_run_at           integer,
    last_ok_at            integer,
    baseline_hash         text,
    baseline_schema_json  text,
    baseline_status       integer,
    baseline_content_type text,
    baseline_at           integer,
    pending_hash          text,
    pending_schema_json   text,
    pending_status        integer,
    pending_content_type  text,
    pending_count         integer not null default 0,
    consecutive_failures  integer not null default 0,
    failure_alerted       integer not null default 0,
    total_checks          integer not null default 0,
    total_incidents       integer not null default 0
  );

  create table snapshots (
    id           text primary key,
    monitor_id   text not null references monitors(id) on delete cascade,
    created_at   integer not null,
    ok           integer not null,
    status_code  integer,
    content_type text,
    latency_ms   integer,
    schema_hash  text,
    schema_json  text,
    error        text
  );

  create table incidents (
    id              text primary key,
    monitor_id      text not null references monitors(id) on delete cascade,
    user_id         text not null references users(id) on delete cascade,
    created_at      integer not null,
    kind            text not null,   -- schema | availability | recovery
    severity        text not null,   -- breaking | warning | info
    summary         text not null,
    changes_json    text not null default '[]',
    from_hash       text,
    to_hash         text,
    acknowledged_at integer
  );

  create table deliveries (
    id              text primary key,
    incident_id     text not null references incidents(id) on delete cascade,
    channel_id      text not null references channels(id) on delete cascade,
    status          text not null default 'pending',  -- pending | sent | failed
    attempts        integer not null default 0,
    next_attempt_at integer not null,
    last_error      text,
    created_at      integer not null,
    sent_at         integer
  );

  create table stripe_events (
    id          text primary key,
    type        text not null,
    received_at integer not null
  );

  create table meta (
    key   text primary key,
    value text not null
  );

  create index idx_monitors_due       on monitors(status, next_run_at);
  create index idx_monitors_user      on monitors(user_id, created_at);
  create index idx_snapshots_monitor  on snapshots(monitor_id, created_at desc);
  create index idx_incidents_monitor  on incidents(monitor_id, created_at desc);
  create index idx_incidents_user     on incidents(user_id, created_at desc);
  create index idx_deliveries_pending on deliveries(status, next_attempt_at);
  create index idx_sessions_expiry    on sessions(expires_at);
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma synchronous = NORMAL');
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const row = db.prepare('pragma user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]!;
    db.exec('begin');
    try {
      db.exec(sql);
      // pragma does not accept bound parameters; the value is a loop counter.
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw new Error(`Migration ${version + 1} failed: ${(error as Error).message}`);
    }
  }
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare('select value from meta where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    'insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value);
}
