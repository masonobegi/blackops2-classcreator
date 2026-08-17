import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffResponseMeta, diffSchemas, maxSeverity, summarize } from '../src/schema/diff.ts';
import { inferSchema } from '../src/schema/infer.ts';

function diff(before: unknown, after: unknown, ignore: string[] = []) {
  return diffSchemas(inferSchema(before), inferSchema(after), ignore);
}

function find(changes: ReturnType<typeof diff>, path: string) {
  return changes.find((change) => change.path === path);
}

test('identical payloads produce no changes', () => {
  assert.deepEqual(diff({ a: 1, b: 'x' }, { a: 1, b: 'y' }), []);
});

test('a removed field is breaking', () => {
  const change = find(diff({ a: 1, b: 2 }, { a: 1 }), '$.b');
  assert.equal(change?.kind, 'field_removed');
  assert.equal(change?.severity, 'breaking');
});

test('an added field is only informational', () => {
  const change = find(diff({ a: 1 }, { a: 1, b: 2 }), '$.b');
  assert.equal(change?.kind, 'field_added');
  assert.equal(change?.severity, 'info');
});

test('a changed type is breaking', () => {
  const change = find(diff({ id: '7' }, { id: 7 }), '$.id');
  assert.equal(change?.kind, 'type_changed');
  assert.equal(change?.severity, 'breaking');
  assert.equal(change?.from, 'string(numeric)');
  assert.equal(change?.to, 'number');
});

test('a field that becomes nullable is breaking', () => {
  const change = find(diff({ email: 'a@b.co' }, { email: null }), '$.email');
  assert.equal(change?.kind, 'became_nullable');
  assert.equal(change?.severity, 'breaking');
});

test('becoming null is reported once, not as a type change as well', () => {
  const changes = diff({ email: 'a@b.co' }, { email: null });
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['became_nullable'],
  );
});

test('a field that starts carrying data is not a breaking change', () => {
  // Going from an always-null field to a real value breaks nobody: any consumer
  // was already handling null. Calling it breaking would be a false alarm.
  const changes = diff({ nickname: null }, { nickname: 'ada' });
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['no_longer_nullable'],
  );
  assert.ok(changes.every((change) => change.severity === 'info'));
});

test('narrowing a nullable union down to always-null is only informational', () => {
  const before = inferSchema([{ x: 'a' }, { x: null }]);
  const after = inferSchema([{ x: null }, { x: null }]);
  const change = diffSchemas(before, after).find((c) => c.path === '$[].x');
  assert.equal(change?.kind, 'type_narrowed');
  assert.equal(change?.severity, 'info');
  assert.match(change!.message, /always null/);
});

test('a field that stops being nullable is only informational', () => {
  const before = inferSchema([{ x: null }, { x: 'a' }]);
  const after = inferSchema([{ x: 'a' }, { x: 'b' }]);
  const change = diffSchemas(before, after).find((c) => c.path === '$[].x');
  assert.equal(change?.kind, 'no_longer_nullable');
  assert.equal(change?.severity, 'info');
});

test('a required field becoming optional is breaking', () => {
  const before = inferSchema([{ a: 1, b: 2 }]);
  const after = inferSchema([{ a: 1, b: 2 }, { a: 1 }]);
  const change = diffSchemas(before, after).find((c) => c.path === '$[].b');
  assert.equal(change?.kind, 'became_optional');
  assert.equal(change?.severity, 'breaking');
});

test('an optional field becoming always present is informational', () => {
  const before = inferSchema([{ a: 1 }, { a: 1, b: 2 }]);
  const after = inferSchema([{ a: 1, b: 2 }]);
  const change = diffSchemas(before, after).find((c) => c.path === '$[].b');
  assert.equal(change?.kind, 'became_required');
  assert.equal(change?.severity, 'info');
});

test('changes inside array elements are found', () => {
  const change = find(diff({ data: [{ id: 1 }] }, { data: [{ id: 1, extra: true }] }), '$.data[].extra');
  assert.equal(change?.kind, 'field_added');
});

test('nested object changes report a full path', () => {
  const changes = diff(
    { result: { customer: { id: 'c1', tier: 'pro' } } },
    { result: { customer: { id: 'c1' } } },
  );
  const change = find(changes, '$.result.customer.tier');
  assert.equal(change?.kind, 'field_removed');
});

test('an array that empties is reported as unobservable, not as a break', () => {
  const changes = diff({ items: [{ a: 1 }] }, { items: [] });
  const change = find(changes, '$.items[]');
  assert.equal(change?.kind, 'unobservable');
  assert.equal(change?.severity, 'info');
});

test('a widened union warns; a narrowed one informs', () => {
  const widened = diffSchemas(inferSchema(['a']), inferSchema(['a', 1]));
  assert.equal(widened.find((c) => c.kind === 'type_widened')?.severity, 'warning');

  const narrowed = diffSchemas(inferSchema(['a', 1]), inferSchema(['a']));
  assert.equal(narrowed.find((c) => c.kind === 'type_narrowed')?.severity, 'info');
});

test('a format change warns without claiming a break', () => {
  const change = find(diff({ at: '2026-01-09T00:00:00Z' }, { at: 'yesterday' }), '$.at');
  assert.equal(change?.kind, 'format_changed');
  assert.equal(change?.severity, 'warning');
});

test('the root type changing is breaking', () => {
  const change = find(diff({ a: 1 }, [{ a: 1 }]), '$');
  assert.equal(change?.severity, 'breaking');
});

test('ignore rules suppress matching paths only', () => {
  const payloadBefore = { meta: { request_id: 'a' }, data: { total: 1 } };
  const payloadAfter = { meta: {}, data: {} };

  const unfiltered = diff(payloadBefore, payloadAfter);
  assert.equal(unfiltered.length, 2);

  const filtered = diff(payloadBefore, payloadAfter, ['$.meta.**']);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.path, '$.data.total');
});

test('changes are ordered worst first', () => {
  const changes = diff({ keep: 1, drop: 2 }, { keep: 1, added: 3 });
  assert.equal(changes[0]!.severity, 'breaking');
  assert.equal(maxSeverity(changes), 'breaking');
});

test('status and content type changes are breaking', () => {
  const changes = diffResponseMeta(
    { status: 200, contentType: 'application/json' },
    { status: 403, contentType: 'text/html' },
  );
  assert.equal(changes.length, 2);
  assert.ok(changes.every((change) => change.severity === 'breaking'));
});

test('summaries lead with the worst change and count the rest', () => {
  const changes = diff({ a: 1, b: 2, c: 3 }, { a: 1 });
  const summary = summarize(changes);
  assert.ok(summary.startsWith('Breaking: '));
  assert.ok(summary.includes('1 other change'));
});
