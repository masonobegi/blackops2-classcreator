import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaderLines, validateChannel, validateMonitor } from '../src/http/validate.ts';
import { openDatabase } from '../src/db.ts';
import { claimStripeEvent } from '../src/store.ts';
import { PLANS } from '../src/plans.ts';

const pro = PLANS.pro;
const free = PLANS.free;

function valid(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Vendor API',
    method: 'GET',
    url: 'https://api.vendor.test/v1/things',
    intervalSeconds: 300,
    ...overrides,
  };
}

test('a well-formed monitor is accepted and normalised', () => {
  const result = validateMonitor(valid({ method: 'get' }), pro);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.method, 'GET');
  assert.equal(result.value.name, 'Vendor API');
  assert.equal(result.value.confirmations, 2);
  assert.equal(result.value.minSeverity, null);
});

test('a name and URL are required', () => {
  const noName = validateMonitor(valid({ name: '  ' }), pro);
  assert.equal(noName.ok, false);
  const noUrl = validateMonitor(valid({ url: '' }), pro);
  assert.equal(noUrl.ok, false);
});

test('non-http schemes are refused at save time', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)']) {
    assert.equal(validateMonitor(valid({ url }), pro).ok, false, `${url} should be refused`);
  }
});

test('HEAD is not an accepted method', () => {
  // HEAD returns no body, so there is no shape to learn and every check would
  // fail as "not JSON". Accepting it would sell a monitor that cannot work.
  assert.equal(validateMonitor(valid({ method: 'HEAD' }), pro).ok, false);
  assert.equal(validateMonitor(valid({ method: 'DELETE' }), pro).ok, false);
  assert.equal(validateMonitor(valid({ method: 'PUT' }), pro).ok, true);
  assert.equal(validateMonitor(valid({ method: 'POST' }), pro).ok, true);
});

test('the interval is clamped up to the plan minimum, never below', () => {
  const tooFast = validateMonitor(valid({ intervalSeconds: 5 }), free);
  assert.equal(tooFast.ok, true);
  if (tooFast.ok) assert.equal(tooFast.value.intervalSeconds, free.minIntervalSeconds);

  const tooSlow = validateMonitor(valid({ intervalSeconds: 999_999 }), pro);
  if (tooSlow.ok) assert.equal(tooSlow.value.intervalSeconds, 86_400);

  const garbage = validateMonitor(valid({ intervalSeconds: 'soon' }), pro);
  if (garbage.ok) assert.equal(garbage.value.intervalSeconds, pro.minIntervalSeconds);
});

test('confirmations are bounded to a sane range', () => {
  const low = validateMonitor(valid({ confirmations: 0 }), pro);
  if (low.ok) assert.equal(low.value.confirmations, 1);
  const high = validateMonitor(valid({ confirmations: 99 }), pro);
  if (high.ok) assert.equal(high.value.confirmations, 5);
});

test('an empty body becomes null rather than an empty string', () => {
  const result = validateMonitor(valid({ body: '   ' }), pro);
  if (result.ok) assert.equal(result.value.body, null);
});

test('ignore paths accept both a list and a textarea', () => {
  const fromArray = validateMonitor(valid({ ignorePaths: ['$.a', ' $.b ', ''] }), pro);
  if (fromArray.ok) assert.deepEqual(fromArray.value.ignorePaths, ['$.a', '$.b']);

  const fromText = validateMonitor(valid({ ignorePaths: '$.a\n# comment\n$.b' }), pro);
  if (fromText.ok) assert.deepEqual(fromText.value.ignorePaths, ['$.a', '$.b']);
});

test('only known severities are honoured', () => {
  const bogus = validateMonitor(valid({ minSeverity: 'catastrophic' }), pro);
  if (bogus.ok) assert.equal(bogus.value.minSeverity, null);
  const real = validateMonitor(valid({ minSeverity: 'breaking' }), pro);
  if (real.ok) assert.equal(real.value.minSeverity, 'breaking');
});

test('headers are parsed from a textarea and sanitised', () => {
  const headers = parseHeaderLines(
    ['authorization: Bearer abc123', '# a comment', 'x-tenant: acme', 'Host: evil.test', 'garbage'].join('\n'),
  );
  assert.deepEqual(headers, { authorization: 'Bearer abc123', 'x-tenant': 'acme' });
});

test('a header value containing a colon survives intact', () => {
  assert.deepEqual(parseHeaderLines('x-url: https://a.test/b?c=d'), {
    'x-url': 'https://a.test/b?c=d',
  });
});

// ------------------------------------------------------------- channels ------

test('email channels are validated and lowercased', () => {
  const ok = validateChannel('email', '  OnCall@Company.COM ');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.target, 'oncall@company.com');

  assert.equal(validateChannel('email', 'not-an-email').ok, false);
  assert.equal(validateChannel('email', '').ok, false);
});

test('webhook channels must be https', () => {
  // Alert payloads describe a customer's internal data shapes, and a Slack hook
  // URL is itself a credential; neither belongs in cleartext.
  assert.equal(validateChannel('webhook', 'http://hooks.company.test/x').ok, false);
  assert.equal(validateChannel('webhook', 'https://hooks.company.test/x').ok, true);
  assert.equal(validateChannel('webhook', 'nonsense').ok, false);
});

test('slack channels must actually point at slack', () => {
  assert.equal(validateChannel('slack', 'https://hooks.slack.com/services/T/B/x').ok, true);
  assert.equal(validateChannel('slack', 'https://evil.test/services/T/B/x').ok, false);
});

test('an unknown channel type is refused', () => {
  assert.equal(validateChannel('carrier-pigeon', 'https://x.test').ok, false);
});

// -------------------------------------------------- stripe event idempotency -

test('a repeated Stripe event id is claimed only once', () => {
  const db = openDatabase(':memory:');
  assert.equal(claimStripeEvent(db, 'evt_1', 'checkout.session.completed'), true);
  assert.equal(claimStripeEvent(db, 'evt_1', 'checkout.session.completed'), false);
  assert.equal(claimStripeEvent(db, 'evt_2', 'checkout.session.completed'), true);
  db.close();
});

test('a real database error is not mistaken for a duplicate event', () => {
  // Swallowing every failure as "already handled" would silently discard billing
  // events whenever the database was momentarily unhappy.
  const db = openDatabase(':memory:');
  db.exec('drop table stripe_events');
  assert.throws(() => claimStripeEvent(db, 'evt_3', 'customer.subscription.updated'));
  db.close();
});
