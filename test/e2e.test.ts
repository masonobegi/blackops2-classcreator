import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../src/config.ts';
import { openDatabase } from '../src/db.ts';
import { createApp } from '../src/http/server.ts';
import { createScheduler } from '../src/monitor/scheduler.ts';
import {
  createApiKey,
  createChannel,
  createLoginToken,
  findSession,
  listChannels,
  listIncidentsForUser,
  listMonitors,
  setUserBilling,
  upsertUser,
} from '../src/store.ts';

/**
 * Exercises the whole business in one pass: a stranger signs in, creates a
 * monitor, the upstream API quietly breaks its contract, and a signed alert
 * lands on a webhook endpoint.
 */

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('end to end: sign in, monitor, detect a break, deliver a signed alert', async (t) => {
  // The app logs to stdout, and interleaving those writes with the test
  // runner's own IPC stream intermittently corrupts it. Capture instead of
  // suppressing, so the logs are still assertable.
  const logged: string[] = [];
  const errored: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => void logged.push(args.join(' '));
  console.warn = (...args: unknown[]) => void logged.push(args.join(' '));
  console.error = (...args: unknown[]) => void errored.push(args.join(' '));
  t.after(() => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });

  // ---- the upstream API we are going to watch -------------------------------
  let upstream: unknown = {
    data: [
      { id: 1, customer_id: 'cus_a', total: 10.5, created: '2026-01-09T10:00:00Z' },
      { id: 2, customer_id: 'cus_b', total: 8, created: '2026-01-09T11:00:00Z' },
    ],
    meta: { request_id: 'req_0001' },
  };
  let upstreamStatus = 200;

  const target = createServer((_req, res) => {
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(upstream));
  });
  const targetPort = await listen(target);

  // ---- the customer's webhook endpoint that receives alerts -----------------
  const received: { body: string; signature: string | undefined }[] = [];
  const collector = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ body, signature: req.headers['driftwatch-signature'] as string | undefined });
      res.writeHead(200);
      res.end('ok');
    });
  });
  const collectorPort = await listen(collector);

  // ---- the app -------------------------------------------------------------
  const config: Config = {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    baseUrl: '',
    databasePath: ':memory:',
    sessionSecret: 'test-session-secret',
    devLogin: false,
    email: { provider: 'none', apiKey: '', from: 'Driftwatch <test@example.com>' },
    stripe: {
      secretKey: '',
      webhookSecret: 'whsec_test',
      prices: { pro: 'price_pro', team: 'price_team' },
      enabled: false,
    },
    scheduler: { enabled: false, tickMs: 1000, concurrency: 4 },
    // The test targets 127.0.0.1, which the SSRF guard blocks by default.
    probe: { maxBytes: 1_000_000, timeoutMs: 5000, allowPrivateTargets: true },
  };

  const db = openDatabase(':memory:');
  const scheduler = createScheduler(db, config);
  const app = createApp({ db, config, scheduler });
  const appPort = await listen(app);
  config.baseUrl = `http://127.0.0.1:${appPort}`;

  t.after(async () => {
    scheduler.stop();
    await Promise.all([close(app), close(target), close(collector)]);
    db.close();
  });

  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const { cookie, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (cookie) headers.set('cookie', cookie);
    return fetch(`${config.baseUrl}${path}`, { ...rest, headers, redirect: 'manual' });
  };

  // ------------------------------------------------------------------ public -
  await t.test('the landing page is public and sells the product', async () => {
    const response = await request('/');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Driftwatch/);
    assert.match(body, /Start monitoring free/);
  });

  await t.test('health and robots endpoints answer', async () => {
    const health = await request('/healthz');
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);

    const robots = await request('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /User-agent/);
  });

  await t.test('the dashboard is not reachable without a session', async () => {
    const response = await request('/dashboard');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /^\/login/);
  });

  await t.test('an unknown page renders a 404 rather than crashing', async () => {
    assert.equal((await request('/nope')).status, 404);
  });

  // -------------------------------------------------------------------- auth -
  await t.test('requesting a sign-in link creates the account', async () => {
    const response = await request('/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'founder@acme.test' }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Check your email/);
  });

  let cookie = '';
  let csrf = '';
  let userId = '';

  await t.test('a magic link exchanges for a session, once', async () => {
    const user = upsertUser(db, 'founder@acme.test');
    userId = user.id;
    const token = createLoginToken(db, user.id);

    const response = await request(`/auth/verify?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');

    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('dw_session='));
    assert.ok(setCookie, 'expected a session cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(';')[0]!;

    const session = findSession(db, cookie.split('=')[1]!);
    assert.ok(session);
    csrf = session.csrf;

    // Replaying the same link must fail: single-use is the whole security model.
    const replay = await request(`/auth/verify?token=${encodeURIComponent(token)}`);
    assert.equal(replay.headers.get('location'), '/login?status=expired');
  });

  await t.test('the dashboard renders for a signed-in user', async () => {
    const response = await request('/dashboard', { cookie });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Create your first monitor/);
  });

  // ---------------------------------------------------------------- monitors -
  await t.test('a form post without a CSRF token is refused', async () => {
    const response = await request('/monitors', {
      method: 'POST',
      cookie,
      body: new URLSearchParams({ name: 'x', url: `http://127.0.0.1:${targetPort}/invoices` }),
    });
    assert.equal(response.status, 403);
    assert.equal(listMonitors(db, userId).length, 0);
  });

  let monitorId = '';

  await t.test('creating a monitor redirects to it', async () => {
    const response = await request('/monitors', {
      method: 'POST',
      cookie,
      body: new URLSearchParams({
        csrf,
        name: 'Vendor invoices',
        method: 'GET',
        url: `http://127.0.0.1:${targetPort}/invoices`,
        headers: 'authorization: Bearer readonly_token',
        interval_seconds: '3600',
        ignore_paths: '$.meta.**',
        min_severity: '',
        confirmations: '2',
      }),
    });
    assert.equal(response.status, 303);
    const location = response.headers.get('location') ?? '';
    assert.match(location, /^\/monitors\/mon_/);
    monitorId = location.replace('/monitors/', '').split('?')[0]!;

    const monitors = listMonitors(db, userId);
    assert.equal(monitors.length, 1);
    assert.equal(monitors[0]!.name, 'Vendor invoices');
    assert.equal(monitors[0]!.status, 'active');
  });

  await t.test('the free plan limit is enforced on the third monitor', async () => {
    const create = (name: string) =>
      request('/monitors', {
        method: 'POST',
        cookie,
        body: new URLSearchParams({
          csrf,
          name,
          method: 'GET',
          url: `http://127.0.0.1:${targetPort}/other`,
          interval_seconds: '3600',
        }),
      });

    const second = await create('Second');
    assert.match(second.headers.get('location') ?? '', /^\/monitors\/mon_/);

    const third = await create('Third');
    assert.equal(third.headers.get('location'), '/dashboard?status=limit-reached');
    assert.equal(listMonitors(db, userId).length, 2);
  });

  // ------------------------------------------------------------- alert route -
  await t.test('alerts are routed to a signed webhook channel', () => {
    // Replace the default email channel with the customer's webhook endpoint.
    for (const channel of listChannels(db, userId)) {
      db.prepare('delete from channels where id = ?').run(channel.id);
    }
    createChannel(db, userId, 'webhook', `http://127.0.0.1:${collectorPort}/hook`, 'Ops');
    assert.equal(listChannels(db, userId).length, 1);
    assert.ok(listChannels(db, userId)[0]!.secret, 'webhook channels get a signing secret');
  });

  // ------------------------------------------------------------- the product -
  await t.test('the first check learns a baseline and alerts nobody', async () => {
    const result = await scheduler.tick();
    assert.equal(result.checked, 2, 'both due monitors were claimed');
    assert.equal(result.incidents, 0);

    const monitor = listMonitors(db, userId).find((row) => row.id === monitorId)!;
    assert.ok(monitor.baseline_hash, 'a baseline was recorded');
    assert.equal(monitor.baseline_status, 200);
    assert.equal(monitor.baseline_content_type, 'application/json');
    assert.equal(monitor.total_checks, 1);
    assert.equal(received.length, 0, 'no alert for a first observation');
  });

  await t.test('an ignored field changing is adopted silently', async () => {
    upstream = {
      data: [
        { id: 1, customer_id: 'cus_a', total: 10.5, created: '2026-01-09T10:00:00Z' },
        { id: 2, customer_id: 'cus_b', total: 8, created: '2026-01-09T11:00:00Z' },
      ],
      // A new field appears, but the whole $.meta subtree is on the ignore list.
      meta: { request_id: 'req_0002', trace: 'abc' },
    };
    await scheduler.runMonitorNow(monitorId);
    await scheduler.runMonitorNow(monitorId);

    assert.equal(listIncidentsForUser(db, userId).length, 0);
    assert.equal(received.length, 0);
  });

  await t.test('a single flaky response does not raise an incident', async () => {
    const good = upstream;
    upstream = { data: [], meta: { request_id: 'req_0003' } }; // one bad response
    await scheduler.runMonitorNow(monitorId);
    upstream = good;
    await scheduler.runMonitorNow(monitorId);

    assert.equal(listIncidentsForUser(db, userId).length, 0, 'confirmation window absorbed it');
  });

  await t.test('a confirmed breaking change raises exactly one incident', async () => {
    // The vendor drops `total` and starts returning null customer ids.
    upstream = {
      data: [
        { id: 1, customer_id: null, created: '2026-01-09T10:00:00Z' },
        { id: 2, customer_id: null, created: '2026-01-09T11:00:00Z' },
      ],
      meta: { request_id: 'req_0004' },
    };

    await scheduler.runMonitorNow(monitorId); // change seen once
    assert.equal(listIncidentsForUser(db, userId).length, 0);

    await scheduler.runMonitorNow(monitorId); // confirmed

    const incidents = listIncidentsForUser(db, userId);
    assert.equal(incidents.length, 1);
    const incident = incidents[0]!;
    assert.equal(incident.severity, 'breaking');
    assert.equal(incident.kind, 'schema');

    const changes = JSON.parse(incident.changes_json) as { path: string; kind: string }[];
    const paths = changes.map((change) => change.path);
    assert.ok(paths.includes('$.data[].total'), `expected removal of total, got ${paths.join(', ')}`);
    assert.ok(paths.includes('$.data[].customer_id'), 'expected nullability change');
    assert.ok(
      !paths.some((path) => path.startsWith('$.meta')),
      'ignored paths must not appear in the diff',
    );
  });

  await t.test('the alert was delivered and is correctly signed', async () => {
    assert.equal(received.length, 1, 'exactly one webhook delivery');

    const delivery = received[0]!;
    const secret = listChannels(db, userId)[0]!.secret!;
    const parts = Object.fromEntries(
      delivery.signature!.split(',').map((part) => part.trim().split('=', 2) as [string, string]),
    );
    const expected = createHmac('sha256', secret)
      .update(`${parts['t']}.${delivery.body}`)
      .digest('hex');
    assert.ok(
      timingSafeEqual(Buffer.from(expected), Buffer.from(parts['v1'] ?? '')),
      'signature must verify against the channel secret',
    );

    const payload = JSON.parse(delivery.body) as {
      type: string;
      incident: { severity: string; url: string };
      monitor: { name: string };
      changes: unknown[];
    };
    assert.equal(payload.type, 'incident.schema');
    assert.equal(payload.incident.severity, 'breaking');
    assert.equal(payload.monitor.name, 'Vendor invoices');
    assert.ok(payload.changes.length >= 2);
    assert.match(payload.incident.url, /\/incidents\/inc_/);

    const queued = db
      .prepare("select count(*) as n from deliveries where status = 'sent'")
      .get() as { n: number };
    assert.equal(queued.n, 1);
  });

  await t.test('the incident page shows the diff', async () => {
    const incident = listIncidentsForUser(db, userId)[0]!;
    const response = await request(`/incidents/${incident.id}`, { cookie });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /\$\.data\[\]\.total/);
    assert.match(body, /BREAKING/);
  });

  await t.test('a 5xx does not overwrite the learned baseline', async () => {
    const before = listMonitors(db, userId).find((row) => row.id === monitorId)!.baseline_hash;
    upstreamStatus = 503;
    await scheduler.runMonitorNow(monitorId);
    await scheduler.runMonitorNow(monitorId);
    upstreamStatus = 200;

    const monitor = listMonitors(db, userId).find((row) => row.id === monitorId)!;
    assert.equal(monitor.baseline_hash, before, 'baseline survived the outage');
    assert.equal(monitor.consecutive_failures, 2);
  });

  await t.test('sustained failure alerts once, then recovery alerts once', async () => {
    upstreamStatus = 503;
    await scheduler.runMonitorNow(monitorId); // third failure -> availability
    await scheduler.runMonitorNow(monitorId); // still down, stays quiet

    const kinds = () => listIncidentsForUser(db, userId).map((incident) => incident.kind);
    assert.equal(kinds().filter((kind) => kind === 'availability').length, 1);

    upstreamStatus = 200;
    await scheduler.runMonitorNow(monitorId);
    assert.equal(kinds().filter((kind) => kind === 'recovery').length, 1);
  });

  // ------------------------------------------------------------------- API ---
  await t.test('the REST API is gated on plan, then works', async () => {
    const anonymous = await request('/api/v1/monitors');
    assert.equal(anonymous.status, 401);

    const { token } = createApiKey(db, userId, 'CI');

    // Still on the free plan: the key is valid but the feature is not included.
    const gated = await request('/api/v1/monitors', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(gated.status, 403);
    assert.equal(((await gated.json()) as { error: { type: string } }).error.type, 'plan_required');

    setUserBilling(db, userId, { plan: 'pro', subscriptionStatus: 'active' });

    const allowed = await request('/api/v1/monitors', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);
    const payload = (await allowed.json()) as { data: { id: string; name: string }[] };
    assert.equal(payload.data.length, 2);
    assert.ok(payload.data.some((monitor) => monitor.name === 'Vendor invoices'));

    // A bad key is rejected even for a paid account.
    const wrong = await request('/api/v1/monitors', {
      headers: { authorization: 'Bearer dw_live_not_a_real_key' },
    });
    assert.equal(wrong.status, 401);
  });

  await t.test('the API creates and deletes monitors', async () => {
    const { token } = createApiKey(db, userId, 'CI 2');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const created = await request('/api/v1/monitors', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Created via API',
        url: `http://127.0.0.1:${targetPort}/api-made`,
        interval_seconds: 300,
        ignore_paths: ['$.meta.**'],
      }),
    });
    assert.equal(created.status, 201);
    const monitor = ((await created.json()) as { data: { id: string; interval_seconds: number } }).data;
    assert.equal(monitor.interval_seconds, 300, 'pro plan allows a 5 minute interval');

    const rejected = await request('/api/v1/monitors', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'No URL' }),
    });
    assert.equal(rejected.status, 422);

    const deleted = await request(`/api/v1/monitors/${monitor.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(deleted.status, 200);
    assert.equal(listMonitors(db, userId).length, 2);
  });

  await t.test('incidents are readable over the API', async () => {
    const { token } = createApiKey(db, userId, 'CI 3');
    const response = await request('/api/v1/incidents?severity=breaking', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data: { severity: string; changes: unknown[] }[] };
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0]!.severity, 'breaking');
    assert.ok(payload.data[0]!.changes.length >= 2);
  });

  // -------------------------------------------------------------- billing ----
  await t.test('checkout is refused cleanly when Stripe is not configured', async () => {
    const response = await request('/billing/checkout', {
      method: 'POST',
      cookie,
      body: new URLSearchParams({ csrf, plan: 'pro' }),
    });
    assert.equal(response.headers.get('location'), '/billing?status=billing-unavailable');
  });

  await t.test('an unsigned Stripe webhook is rejected', async () => {
    const response = await request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed' }),
    });
    assert.equal(response.status, 400);
    assert.equal(
      ((await response.json()) as { error: { type: string } }).error.type,
      'invalid_signature',
    );
  });

  await t.test('signing out clears the session', async () => {
    const response = await request('/logout', {
      method: 'POST',
      cookie,
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(response.status, 303);
    const after = await request('/dashboard', { cookie });
    assert.equal(after.status, 303, 'the old cookie no longer authenticates');
  });

  await t.test('nothing in that whole run logged an internal error', () => {
    // Handlers that throw, monitor checks that blow up and failed deliveries all
    // land on console.error. A clean run must produce none of them.
    assert.deepEqual(errored, []);
    // And the incidents we expected really were logged as they happened.
    assert.equal(logged.filter((line) => line.includes('breaking —')).length, 1);
  });
});
