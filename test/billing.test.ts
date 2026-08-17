import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  encodeForm,
  periodEndMs,
  planForPrice,
  priceIdOf,
  verifyWebhookSignature,
  type StripeSubscription,
} from '../src/billing/stripe.ts';
import { openDatabase } from '../src/db.ts';
import { applyEntitlements } from '../src/billing/entitlements.ts';
import { effectivePlan, isEntitled, PLANS } from '../src/plans.ts';
import {
  createMonitor,
  listMonitorsOldestFirst,
  setUserBilling,
  upsertUser,
} from '../src/store.ts';
import type { Config } from '../src/config.ts';

const SECRET = 'whsec_test_secret';

function sign(payload: string, timestamp: number, secret = SECRET): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('a correctly signed webhook is accepted', () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_700_000_000;
  const result = verifyWebhookSignature(payload, sign(payload, now), SECRET, 300, now);
  assert.deepEqual(result, { ok: true });
});

test('a tampered body is rejected', () => {
  const now = 1_700_000_000;
  const header = sign('{"id":"evt_1"}', now);
  const result = verifyWebhookSignature('{"id":"evt_2"}', header, SECRET, 300, now);
  assert.equal(result.ok, false);
});

test('the wrong secret is rejected', () => {
  const payload = '{"a":1}';
  const now = 1_700_000_000;
  const header = sign(payload, now, 'whsec_other');
  assert.equal(verifyWebhookSignature(payload, header, SECRET, 300, now).ok, false);
});

test('a stale timestamp is rejected even with a valid signature', () => {
  const payload = '{"a":1}';
  const signedAt = 1_700_000_000;
  const header = sign(payload, signedAt);
  // Replayed an hour later.
  const result = verifyWebhookSignature(payload, header, SECRET, 300, signedAt + 3600);
  assert.equal(result.ok, false);
});

test('missing or malformed signature headers are rejected', () => {
  assert.equal(verifyWebhookSignature('{}', null, SECRET).ok, false);
  assert.equal(verifyWebhookSignature('{}', 'garbage', SECRET).ok, false);
  assert.equal(verifyWebhookSignature('{}', 't=123', SECRET).ok, false);
});

test('an unconfigured secret never verifies', () => {
  const payload = '{}';
  const now = 1_700_000_000;
  assert.equal(verifyWebhookSignature(payload, sign(payload, now), '', 300, now).ok, false);
});

test('multiple v1 signatures are accepted when one matches (key rotation)', () => {
  const payload = '{"a":1}';
  const now = 1_700_000_000;
  const good = createHmac('sha256', SECRET).update(`${now}.${payload}`).digest('hex');
  const header = `t=${now},v1=${'0'.repeat(64)},v1=${good}`;
  assert.deepEqual(verifyWebhookSignature(payload, header, SECRET, 300, now), { ok: true });
});

test('form encoding handles Stripe bracket syntax', () => {
  const encoded = encodeForm({
    mode: 'subscription',
    line_items: [{ price: 'price_123', quantity: 1 }],
    metadata: { user: 'usr_1' },
    empty: null,
  });
  const parsed = new URLSearchParams(encoded);
  assert.equal(parsed.get('mode'), 'subscription');
  assert.equal(parsed.get('line_items[0][price]'), 'price_123');
  assert.equal(parsed.get('line_items[0][quantity]'), '1');
  assert.equal(parsed.get('metadata[user]'), 'usr_1');
  assert.equal(parsed.has('empty'), false);
});

test('form encoding escapes values', () => {
  const parsed = new URLSearchParams(encodeForm({ 'success_url': 'https://x.dev/a?b=c&d=e' }));
  assert.equal(parsed.get('success_url'), 'https://x.dev/a?b=c&d=e');
});

const config = {
  stripe: { prices: { pro: 'price_pro', team: 'price_team' } },
} as Config;

test('prices map back to plans, and unknown prices map to nothing', () => {
  assert.equal(planForPrice(config, 'price_pro'), 'pro');
  assert.equal(planForPrice(config, 'price_team'), 'team');
  assert.equal(planForPrice(config, 'price_unknown'), null);
  assert.equal(planForPrice(config, undefined), null);
});

test('period end is read from either the subscription or its items', () => {
  const legacy: StripeSubscription = {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    current_period_end: 1_700_000_000,
    items: { data: [{ price: { id: 'price_pro' } }] },
  };
  const modern: StripeSubscription = {
    id: 'sub_2',
    status: 'active',
    customer: 'cus_1',
    items: { data: [{ price: { id: 'price_team' }, current_period_end: 1_800_000_000 }] },
  };
  assert.equal(periodEndMs(legacy), 1_700_000_000_000);
  assert.equal(periodEndMs(modern), 1_800_000_000_000);
  assert.equal(priceIdOf(modern), 'price_team');
});

test('entitlement follows subscription status, not just the stored plan', () => {
  assert.equal(effectivePlan('pro', 'active').id, 'pro');
  assert.equal(effectivePlan('pro', 'trialing').id, 'pro');
  // Stripe retries a failed charge for weeks; cutting access off immediately
  // churns customers who would have paid.
  assert.equal(effectivePlan('pro', 'past_due').id, 'pro');
  assert.equal(effectivePlan('pro', 'canceled').id, 'free');
  assert.equal(effectivePlan('pro', 'unpaid').id, 'free');
  assert.equal(effectivePlan('pro', null).id, 'free');
  assert.ok(isEntitled('active'));
  assert.ok(!isEntitled('incomplete_expired'));
});

test('downgrading pauses the newest monitors and keeps the oldest running', () => {
  const db = openDatabase(':memory:');
  const user = upsertUser(db, 'downgrade@example.com');
  setUserBilling(db, user.id, { plan: 'pro', subscriptionStatus: 'active' });

  for (let i = 0; i < 5; i++) {
    createMonitor(db, {
      userId: user.id,
      name: `m${i}`,
      method: 'GET',
      url: `https://api.example.com/${i}`,
      headers: {},
      body: null,
      intervalSeconds: 300,
      ignorePaths: [],
      minSeverity: null,
    });
  }

  // Cancellation arrives.
  setUserBilling(db, user.id, { plan: 'free', subscriptionStatus: 'canceled' });
  const result = applyEntitlements(db, user.id);

  assert.equal(result?.plan.id, 'free');
  assert.equal(result?.paused, 5 - PLANS.free.monitors);

  const monitors = listMonitorsOldestFirst(db, user.id);
  assert.deepEqual(
    monitors.map((monitor) => monitor.status),
    ['active', 'active', 'paused', 'paused', 'paused'],
  );
  // Nothing was deleted: history and config survive for a win-back.
  assert.equal(monitors.length, 5);
  // Intervals are clamped up to the free minimum.
  assert.ok(monitors.every((monitor) => monitor.interval_seconds >= PLANS.free.minIntervalSeconds));
  db.close();
});

test('upgrading resumes what the plan limit paused, but not manual pauses', () => {
  const db = openDatabase(':memory:');
  const user = upsertUser(db, 'upgrade@example.com');

  [0, 1, 2, 3].forEach((index) =>
    createMonitor(db, {
      userId: user.id,
      name: `m${index}`,
      method: 'GET',
      url: `https://api.example.com/${index}`,
      headers: {},
      body: null,
      intervalSeconds: 3600,
      ignorePaths: [],
      minSeverity: null,
    }),
  );

  // On the free plan the last two get auto-paused.
  applyEntitlements(db, user.id);
  // The customer also pauses the oldest one deliberately. Identify it the same
  // way entitlement enforcement does, so the two agree on "oldest".
  const oldest = listMonitorsOldestFirst(db, user.id)[0]!;
  db.prepare("update monitors set status = 'paused', pause_reason = 'Paused by you' where id = ?").run(
    oldest.id,
  );

  setUserBilling(db, user.id, { plan: 'pro', subscriptionStatus: 'active' });
  applyEntitlements(db, user.id);

  const after = listMonitorsOldestFirst(db, user.id);
  assert.equal(after[0]!.status, 'paused', 'a manual pause must be respected');
  assert.deepEqual(
    after.slice(1).map((monitor) => monitor.status),
    ['active', 'active', 'active'],
  );
  db.close();
});
