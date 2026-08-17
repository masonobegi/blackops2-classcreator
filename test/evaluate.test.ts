import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, evaluate, type EvalOptions, type EvalState } from '../src/monitor/evaluate.ts';
import type { ProbeOutcome } from '../src/monitor/probe.ts';

const OPTIONS: EvalOptions = {
  ignorePaths: [],
  confirmations: 2,
  failureThreshold: 3,
  now: 1_700_000_000_000,
};

function ok(body: unknown, status = 200, contentType = 'application/json'): ProbeOutcome {
  return { ok: true, status, contentType, latencyMs: 12, body, bytes: 100 };
}

function failed(error = 'Request timed out'): ProbeOutcome {
  return { ok: false, status: null, contentType: null, latencyMs: 15_000, error };
}

/** Feed a sequence of outcomes through the state machine. */
function run(
  outcomes: ProbeOutcome[],
  options: Partial<EvalOptions> = {},
  initial: EvalState = emptyState(),
) {
  let state = initial;
  const incidents = [];
  const notes: string[] = [];
  for (const outcome of outcomes) {
    const result = evaluate(state, outcome, { ...OPTIONS, ...options });
    state = result.state;
    notes.push(result.note);
    if (result.incident) incidents.push(result.incident);
  }
  return { state, incidents, notes };
}

test('the first successful check establishes a baseline silently', () => {
  const { state, incidents, notes } = run([ok({ a: 1 })]);
  assert.equal(incidents.length, 0);
  assert.equal(notes[0], 'baseline established');
  assert.ok(state.baselineHash);
  assert.ok(state.baselineSchema);
  assert.equal(state.baselineStatus, 200);
});

test('an unchanged response never alerts', () => {
  const { incidents, notes } = run([ok({ a: 1 }), ok({ a: 2 }), ok({ a: 3 })]);
  assert.equal(incidents.length, 0);
  assert.deepEqual(notes.slice(1), ['no change', 'no change']);
});

test('a change is not reported until it is confirmed', () => {
  const { incidents, notes } = run([ok({ a: 1, b: 2 }), ok({ a: 1 })]);
  assert.equal(incidents.length, 0);
  assert.equal(notes[1], 'change seen 1 of 2 needed to confirm');
});

test('a change seen twice in a row becomes one breaking incident', () => {
  const { incidents } = run([ok({ a: 1, b: 2 }), ok({ a: 1 }), ok({ a: 1 })]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, 'schema');
  assert.equal(incidents[0]!.severity, 'breaking');
  assert.match(incidents[0]!.summary, /\$\.b was removed/);
});

test('a one-off flake followed by the original shape stays silent', () => {
  // This is the single most important behaviour in the product: a stale node
  // behind a load balancer must not page anyone.
  const { incidents } = run([ok({ a: 1, b: 2 }), ok({ a: 1 }), ok({ a: 1, b: 2 })]);
  assert.equal(incidents.length, 0);
});

test('two different changes in a row do not confirm each other', () => {
  const { incidents } = run([ok({ a: 1, b: 2, c: 3 }), ok({ a: 1, b: 2 }), ok({ a: 1, c: 3 })]);
  assert.equal(incidents.length, 0);
});

test('confirmations of 1 alerts immediately', () => {
  const { incidents } = run([ok({ a: 1, b: 2 }), ok({ a: 1 })], { confirmations: 1 });
  assert.equal(incidents.length, 1);
});

test('the same change is never reported twice', () => {
  const { incidents } = run([
    ok({ a: 1, b: 2 }),
    ok({ a: 1 }),
    ok({ a: 1 }), // incident here
    ok({ a: 1 }),
    ok({ a: 1 }),
  ]);
  assert.equal(incidents.length, 1);
});

test('a status code change is breaking even when the body shape holds', () => {
  const { incidents } = run([ok({ error: 'x' }, 200), ok({ error: 'x' }, 403), ok({ error: 'x' }, 403)]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.severity, 'breaking');
  assert.ok(incidents[0]!.changes.some((change) => change.path === '$status'));
});

test('ignored paths are adopted without an alert', () => {
  const { incidents, notes } = run(
    [
      ok({ data: 1, meta: { request_id: 'a' } }),
      ok({ data: 1, meta: { request_id: 'b', extra: true } }),
      ok({ data: 1, meta: { request_id: 'c', extra: true } }),
    ],
    { ignorePaths: ['$.meta.**'] },
  );
  assert.equal(incidents.length, 0);
  assert.equal(notes[2], 'change confirmed but fully ignored by path rules');
});

test('a failure does not destroy the baseline', () => {
  const { state, incidents } = run([ok({ a: 1, b: 2 }), failed(), failed()]);
  assert.equal(incidents.length, 0);
  assert.ok(state.baselineSchema, 'baseline should survive failures');
  assert.equal(state.consecutiveFailures, 2);
});

test('repeated failures raise exactly one availability incident', () => {
  const { incidents, state } = run([ok({ a: 1 }), failed(), failed(), failed(), failed(), failed()]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, 'availability');
  assert.equal(incidents[0]!.severity, 'warning');
  assert.ok(state.failureAlerted);
});

test('recovery after an availability alert produces a recovery incident', () => {
  const { incidents, state } = run([
    ok({ a: 1 }),
    failed(),
    failed(),
    failed(), // availability incident
    ok({ a: 1 }), // recovery
  ]);
  assert.equal(incidents.length, 2);
  assert.equal(incidents[1]!.kind, 'recovery');
  assert.equal(incidents[1]!.severity, 'info');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.failureAlerted, false);
});

test('recovery is not announced when nothing was ever announced', () => {
  const { incidents } = run([ok({ a: 1 }), failed(), ok({ a: 1 })]);
  assert.equal(incidents.length, 0);
});

test('recovering with a changed shape reports both, without losing either', () => {
  const { incidents } = run([
    ok({ a: 1, b: 2 }),
    failed(),
    failed(),
    failed(), // availability
    ok({ a: 1 }), // recovery, change pending
    ok({ a: 1 }), // change confirmed
  ]);
  assert.equal(incidents.length, 3);
  assert.deepEqual(
    incidents.map((incident) => incident.kind),
    ['availability', 'recovery', 'schema'],
  );
});

test('a failure before any baseline exists still alerts on threshold', () => {
  const { incidents, state } = run([failed(), failed(), failed()]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, 'availability');
  assert.equal(state.baselineSchema, null);
});

test('incident hashes point from the old shape to the new one', () => {
  const { incidents } = run([ok({ a: 1, b: 2 }), ok({ a: 1 }), ok({ a: 1 })]);
  const incident = incidents[0]!;
  assert.ok(incident.fromHash);
  assert.ok(incident.toHash);
  assert.notEqual(incident.fromHash, incident.toHash);
});

test('content type changes are treated as contract changes', () => {
  const { incidents } = run([
    ok({ a: 1 }, 200, 'application/json'),
    ok({ a: 1 }, 200, 'text/plain'),
    ok({ a: 1 }, 200, 'text/plain'),
  ]);
  assert.equal(incidents.length, 1);
  assert.ok(incidents[0]!.changes.some((change) => change.path === '$contentType'));
});

test('evaluate does not mutate the state it was given', () => {
  const initial = emptyState();
  const frozen = { ...initial };
  evaluate(initial, ok({ a: 1 }), OPTIONS);
  assert.deepEqual(initial, frozen);
});
