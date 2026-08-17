import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  describe as describeNode,
  detectFormat,
  inferSchema,
  isNullable,
  mergeSchemas,
  schemaHash,
} from '../src/schema/infer.ts';

test('infers primitive kinds', () => {
  assert.deepEqual(inferSchema(null), { t: 'null' });
  assert.deepEqual(inferSchema(true), { t: 'bool' });
  assert.deepEqual(inferSchema(42), { t: 'number' });
  assert.deepEqual(inferSchema('hello'), { t: 'string' });
});

test('integers and floats are both just number', () => {
  // Distinguishing them would alert every time a price gained a decimal.
  assert.equal(schemaHash(inferSchema(10)), schemaHash(inferSchema(10.5)));
});

test('detects string formats', () => {
  assert.equal(detectFormat('2026-01-09T11:22:33Z'), 'datetime');
  assert.equal(detectFormat('2026-01-09 11:22:33'), 'datetime');
  assert.equal(detectFormat('2026-01-09'), 'date');
  assert.equal(detectFormat('7f4d8a1e-9b2c-4d3e-8f1a-2b3c4d5e6f70'), 'uuid');
  assert.equal(detectFormat('someone@example.com'), 'email');
  assert.equal(detectFormat('https://example.com/x'), 'url');
  assert.equal(detectFormat('-12.5'), 'numeric');
  assert.equal(detectFormat(''), 'empty');
  assert.equal(detectFormat('just some text'), undefined);
});

test('infers object properties as required', () => {
  const schema = inferSchema({ id: 1, name: 'x' });
  assert.equal(schema.t, 'object');
  if (schema.t !== 'object') return;
  assert.equal(schema.props['id']!.optional, false);
  assert.equal(schema.props['name']!.schema.t, 'string');
});

test('array elements are merged, and missing keys become optional', () => {
  const schema = inferSchema([
    { id: 1, nickname: 'a' },
    { id: 2 },
    { id: 3, nickname: 'c' },
  ]);
  assert.equal(schema.t, 'array');
  if (schema.t !== 'array' || schema.items?.t !== 'object') {
    assert.fail('expected array of objects');
    return;
  }
  assert.equal(schema.items.props['id']!.optional, false);
  assert.equal(schema.items.props['nickname']!.optional, true);
});

test('an empty array is recorded as unobserved rather than guessed', () => {
  const schema = inferSchema([]);
  assert.deepEqual(schema, { t: 'array', items: null });
});

test('merging different kinds produces a union', () => {
  const merged = mergeSchemas(inferSchema('x'), inferSchema(1));
  assert.equal(merged.t, 'union');
  assert.equal(describeNode(merged), 'number | string');
});

test('nullability survives merging and is detectable', () => {
  const merged = mergeSchemas(inferSchema(null), inferSchema('x'));
  assert.ok(isNullable(merged));
  assert.ok(!isNullable(inferSchema('x')));
});

test('an empty string does not erase a known format', () => {
  const merged = mergeSchemas(
    inferSchema('2026-01-09T11:22:33Z'),
    inferSchema(''),
  );
  assert.deepEqual(merged, { t: 'string', fmt: 'datetime' });
});

test('conflicting formats collapse to a plain string', () => {
  const merged = mergeSchemas(inferSchema('2026-01-09'), inferSchema('someone@example.com'));
  assert.deepEqual(merged, { t: 'string' });
});

test('canonical form is key-order independent', () => {
  const a = inferSchema({ b: 1, a: 'x', c: [1, 2] });
  const b = inferSchema({ c: [3], a: 'y', b: 9 });
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(schemaHash(a), schemaHash(b));
});

test('optionality changes the fingerprint', () => {
  const required = inferSchema([{ a: 1, b: 2 }]);
  const optional = inferSchema([{ a: 1, b: 2 }, { a: 1 }]);
  assert.notEqual(schemaHash(required), schemaHash(optional));
});

test('deeply nested payloads terminate', () => {
  let nested: unknown = 'leaf';
  for (let i = 0; i < 200; i++) nested = { next: nested };
  assert.doesNotThrow(() => schemaHash(inferSchema(nested)));
});

test('describe produces readable types', () => {
  assert.equal(describeNode(inferSchema([{ a: 1 }])), 'array<object(1 field)>');
  assert.equal(describeNode(inferSchema('2026-01-09')), 'string(date)');
  assert.equal(describeNode(inferSchema([])), 'array<empty>');
});
