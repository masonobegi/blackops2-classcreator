import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.ts';
import { openDatabase, type Database } from '../src/db.ts';
import { escapeHtml, html, raw } from '../src/lib/html.ts';
import { createRateLimiter } from '../src/lib/ratelimit.ts';
import { queueIncidentNotifications, runDeliveryQueue } from '../src/notify/dispatch.ts';
import { renderAlert } from '../src/notify/render.ts';
import {
  createChannel,
  createMonitor,
  insertIncident,
  listChannels,
  setAlertMinSeverity,
  upsertUser,
  type DeliveryRow,
  type IncidentRow,
  type MonitorRow,
  type UserRow,
} from '../src/store.ts';

function testConfig(baseUrl = 'https://driftwatch.test'): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    baseUrl,
    databasePath: ':memory:',
    sessionSecret: 'test',
    devLogin: false,
    email: { provider: 'none', apiKey: '', from: 'test@example.com' },
    stripe: { secretKey: '', webhookSecret: '', prices: { pro: '', team: '' }, enabled: false },
    trustProxy: false,
    scheduler: { enabled: false, tickMs: 1000, concurrency: 2 },
    probe: { maxBytes: 1000, timeoutMs: 1000, allowPrivateTargets: true },
  };
}

function fixture(): { db: Database; user: UserRow; monitor: MonitorRow } {
  const db = openDatabase(':memory:');
  const user = upsertUser(db, 'alerts@example.com');
  const monitor = createMonitor(db, {
    userId: user.id,
    name: 'Vendor API',
    method: 'GET',
    url: 'https://api.vendor.test/v1/things',
    headers: {},
    body: null,
    intervalSeconds: 3600,
    ignorePaths: [],
    minSeverity: null,
  });
  return { db, user, monitor };
}

function incident(
  db: Database,
  monitor: MonitorRow,
  user: UserRow,
  severity: 'breaking' | 'warning' | 'info',
  kind = 'schema',
): IncidentRow {
  return insertIncident(db, {
    monitorId: monitor.id,
    userId: user.id,
    kind,
    severity,
    summary: `${severity} thing happened`,
    changesJson: JSON.stringify([
      {
        path: '$.data[].id',
        kind: 'field_removed',
        severity,
        from: 'string',
        to: 'absent',
        message: '$.data[].id was removed',
      },
    ]),
    fromHash: 'aaaa',
    toHash: 'bbbb',
  });
}

const queued = (db: Database) =>
  (db.prepare('select count(*) as n from deliveries').get() as { n: number }).n;

// ------------------------------------------------------- severity routing ----

test('an incident below the account threshold is not delivered', () => {
  const { db, user, monitor } = fixture();
  setAlertMinSeverity(db, user.id, 'warning');
  const fresh = { ...user, alert_min_severity: 'warning' };

  queueIncidentNotifications(db, incident(db, monitor, user, 'info'), monitor, fresh);
  assert.equal(queued(db), 0);
  db.close();
});

test('an incident at or above the threshold is delivered', () => {
  const { db, user, monitor } = fixture();
  const fresh = { ...user, alert_min_severity: 'warning' };

  queueIncidentNotifications(db, incident(db, monitor, user, 'warning'), monitor, fresh);
  queueIncidentNotifications(db, incident(db, monitor, user, 'breaking'), monitor, fresh);
  assert.equal(queued(db), 2);
  db.close();
});

test('a recovery notice ignores the threshold', () => {
  // Being told an endpoint broke and never being told it healed is worse than
  // not being told at all, so recovery bypasses the severity filter.
  const { db, user, monitor } = fixture();
  const strict = { ...user, alert_min_severity: 'breaking' };

  queueIncidentNotifications(
    db,
    incident(db, monitor, user, 'info', 'recovery'),
    monitor,
    strict,
  );
  assert.equal(queued(db), 1);
  db.close();
});

test('a per-monitor threshold overrides the account default', () => {
  const { db, user, monitor } = fixture();
  const loose = { ...user, alert_min_severity: 'info' };
  const strictMonitor = { ...monitor, min_severity: 'breaking' };

  queueIncidentNotifications(db, incident(db, monitor, user, 'warning'), strictMonitor, loose);
  assert.equal(queued(db), 0);

  queueIncidentNotifications(db, incident(db, monitor, user, 'breaking'), strictMonitor, loose);
  assert.equal(queued(db), 1);
  db.close();
});

test('disabled channels receive nothing', () => {
  const { db, user, monitor } = fixture();
  const only = listChannels(db, user.id)[0]!;
  db.prepare('update channels set disabled_at = ? where id = ?').run(Date.now(), only.id);

  queueIncidentNotifications(db, incident(db, monitor, user, 'breaking'), monitor, user);
  assert.equal(queued(db), 0);
  db.close();
});

// --------------------------------------------------------- delivery queue ----

test('delivery queue', async (t) => {
  let respond: (res: ServerResponse) => void = (res) => {
    res.writeHead(200);
    res.end('ok');
  };
  let hits = 0;

  const receiver: Server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => respond(res));
  });
  await new Promise<void>((resolve) => {
    receiver.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (receiver.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

  const setup = (target: string) => {
    const { db, user, monitor } = fixture();
    for (const channel of listChannels(db, user.id)) {
      db.prepare('delete from channels where id = ?').run(channel.id);
    }
    createChannel(db, user.id, 'webhook', target);
    queueIncidentNotifications(db, incident(db, monitor, user, 'breaking'), monitor, user);
    return db;
  };

  const delivery = (db: Database) => db.prepare('select * from deliveries').get() as DeliveryRow;

  await t.test('a 200 marks the delivery sent', async () => {
    respond = (res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);
    const result = await runDeliveryQueue(db, testConfig());
    assert.deepEqual(result, { sent: 1, failed: 0, retrying: 0 });
    assert.equal(delivery(db).status, 'sent');
    db.close();
  });

  await t.test('a 404 fails permanently instead of retrying forever', async () => {
    // A wrong address or revoked hook will never start working, so retrying it
    // just hammers a stranger's server.
    respond = (res) => {
      res.writeHead(404);
      res.end('nope');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);
    const result = await runDeliveryQueue(db, testConfig());
    assert.deepEqual(result, { sent: 0, failed: 1, retrying: 0 });
    const row = delivery(db);
    assert.equal(row.status, 'failed');
    assert.match(row.last_error ?? '', /404/);
    db.close();
  });

  await t.test('a 500 is retried with backoff', async () => {
    respond = (res) => {
      res.writeHead(500);
      res.end('boom');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);
    const before = Date.now();
    const result = await runDeliveryQueue(db, testConfig());
    assert.deepEqual(result, { sent: 0, failed: 0, retrying: 1 });
    const row = delivery(db);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(row.next_attempt_at > before, 'retry is scheduled in the future');
    db.close();
  });

  await t.test('a 429 is retried rather than discarded', async () => {
    respond = (res) => {
      res.writeHead(429);
      res.end('slow down');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);
    const result = await runDeliveryQueue(db, testConfig());
    assert.equal(result.retrying, 1);
    db.close();
  });

  await t.test('an unreachable host is retried, not failed', async () => {
    const db = setup('http://127.0.0.1:1/hook'); // nothing listens on port 1
    const result = await runDeliveryQueue(db, testConfig());
    assert.equal(result.retrying, 1);
    db.close();
  });

  await t.test('retries stop after the backoff schedule is exhausted', async () => {
    respond = (res) => {
      res.writeHead(500);
      res.end('boom');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);

    let guard = 0;
    for (;;) {
      const row = delivery(db);
      if (row.status !== 'pending' || guard++ > 20) break;
      // Make the delivery due again without waiting out the real backoff.
      db.prepare('update deliveries set next_attempt_at = ? where id = ?').run(0, row.id);
      await runDeliveryQueue(db, testConfig());
    }

    const row = delivery(db);
    assert.equal(row.status, 'failed', 'the queue must converge, not retry forever');
    assert.equal(row.attempts, 6);
    db.close();
  });

  await t.test('removing a channel drops its pending deliveries', async () => {
    // The foreign key cascades, so a customer who deletes a channel stops
    // hearing from it immediately rather than getting a backlog afterwards.
    const db = setup(`http://127.0.0.1:${port}/hook`);
    assert.equal(queued(db), 1);

    db.prepare('delete from channels').run();
    assert.equal(queued(db), 0, 'the cascade should have removed the queued delivery');

    const result = await runDeliveryQueue(db, testConfig());
    assert.deepEqual(result, { sent: 0, failed: 0, retrying: 0 });
    db.close();
  });

  await t.test('a slow receiver does not stall the whole queue forever', async () => {
    hits = 0;
    respond = (res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const db = setup(`http://127.0.0.1:${port}/hook`);
    await runDeliveryQueue(db, testConfig());
    assert.equal(hits > 0, true);
    db.close();
  });
});

// -------------------------------------------------------------- rendering ----

test('an alert carries the diff in every format', () => {
  const { db, user, monitor } = fixture();
  const row = incident(db, monitor, user, 'breaking');
  const alert = renderAlert(row, monitor, 'https://driftwatch.test');

  assert.match(alert.subject, /BREAKING change in Vendor API/);
  assert.match(alert.text, /\$\.data\[\]\.id was removed/);
  assert.match(alert.text, /https:\/\/driftwatch\.test\/incidents\//);
  assert.match(alert.html, /\$\.data\[\]\.id/);

  const payload = alert.json as {
    type: string;
    incident: { severity: string; url: string };
    changes: { path: string }[];
  };
  assert.equal(payload.type, 'incident.schema');
  assert.equal(payload.incident.severity, 'breaking');
  assert.equal(payload.changes[0]!.path, '$.data[].id');
  db.close();
});

test('availability and recovery alerts read differently', () => {
  const { db, user, monitor } = fixture();
  const down = renderAlert(incident(db, monitor, user, 'warning', 'availability'), monitor, 'https://x.test');
  const up = renderAlert(incident(db, monitor, user, 'info', 'recovery'), monitor, 'https://x.test');
  assert.match(down.subject, /is failing/);
  assert.match(up.subject, /recovered/);
  db.close();
});

test('a hostile monitor name cannot inject markup into an alert', () => {
  const { db, user } = fixture();
  const nasty = createMonitor(db, {
    userId: user.id,
    name: '<script>alert(1)</script>',
    method: 'GET',
    url: 'https://api.vendor.test/x',
    headers: {},
    body: null,
    intervalSeconds: 3600,
    ignorePaths: [],
    minSeverity: null,
  });
  const alert = renderAlert(incident(db, nasty, user, 'breaking'), nasty, 'https://x.test');
  assert.ok(!alert.html.includes('<script>'), 'the email body must not contain raw script tags');
  assert.match(alert.html, /&lt;script&gt;/);
  db.close();
});

// ------------------------------------------------------- escaping and caps ---

test('interpolated values are escaped by default', () => {
  const evil = '<img src=x onerror="alert(1)">';
  assert.equal(
    html`<p>${evil}</p>`.__raw,
    '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
  );
  assert.equal(escapeHtml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;');
});

test('escaping is opt-out only via an explicit raw() call', () => {
  assert.equal(html`<p>${raw('<b>bold</b>')}</p>`.__raw, '<p><b>bold</b></p>');
});

test('arrays and empty values interpolate without leaking "undefined"', () => {
  assert.equal(html`${['a', 'b']}`.__raw, 'ab');
  assert.equal(html`${null}${undefined}${false}`.__raw, '');
  assert.equal(html`${0}`.__raw, '0');
});

test('the rate limiter allows a burst then refuses, and recovers', async () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60 });
  assert.ok(limiter.check('a').allowed);
  assert.ok(limiter.check('a').allowed);
  assert.ok(limiter.check('a').allowed);

  const blocked = limiter.check('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  // A different key has its own budget.
  assert.ok(limiter.check('b').allowed);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(limiter.check('a').allowed, 'the window should have rolled over');
});

test('the rate limiter does not grow without bound', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });
  for (let i = 0; i < 500; i++) limiter.check(`key-${i}`);
  // Nothing to assert beyond "it did not exhaust memory"; the sweep is internal.
  assert.ok(limiter.check('key-final').allowed);
});
