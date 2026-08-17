import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, matchPath, parseIgnorePaths, splitPath } from '../src/schema/paths.ts';

test('splits paths into segments', () => {
  assert.deepEqual(splitPath('$.data[].id'), ['data', '[]', 'id']);
  assert.deepEqual(splitPath('$.meta.request_id'), ['meta', 'request_id']);
  assert.deepEqual(splitPath('$status'), ['$status']);
});

test('nested arrays keep one segment per level', () => {
  assert.deepEqual(splitPath('$.rows[][]'), ['rows', '[]', '[]']);
});

test('exact patterns match', () => {
  assert.ok(matchPath('$.meta.request_id', '$.meta.request_id'));
  assert.ok(!matchPath('$.meta.request_id', '$.meta.other'));
});

test('single-segment wildcard does not cross array markers', () => {
  assert.ok(matchPath('$.meta.*', '$.meta.request_id'));
  assert.ok(!matchPath('$.meta.*', '$.meta.a.b'));
  assert.ok(!matchPath('$.data.*', '$.data[]'));
});

test('double wildcard spans any depth, including zero segments', () => {
  assert.ok(matchPath('$.**.server_time', '$.server_time'));
  assert.ok(matchPath('$.**.server_time', '$.a.b.c.server_time'));
  assert.ok(matchPath('$.debug.**', '$.debug'));
  assert.ok(matchPath('$.debug.**', '$.debug.a.b'));
  assert.ok(!matchPath('$.debug.**', '$.other.a'));
});

test('array element fields can be ignored', () => {
  assert.ok(matchPath('$.data[].updated_at', '$.data[].updated_at'));
  assert.ok(matchPath('$.data[].*', '$.data[].updated_at'));
});

test('empty and comment lines are dropped when parsing', () => {
  assert.deepEqual(
    parseIgnorePaths('$.a\n\n  # a comment\n$.b , $.c\n'),
    ['$.a', '$.b', '$.c'],
  );
});

test('isIgnored matches against a list', () => {
  const patterns = ['$.meta.**', '$.data[].updated_at'];
  assert.ok(isIgnored('$.meta.request_id', patterns));
  assert.ok(isIgnored('$.data[].updated_at', patterns));
  assert.ok(!isIgnored('$.data[].total', patterns));
});

test('an empty pattern never matches anything', () => {
  assert.ok(!matchPath('', '$.a'));
  assert.ok(!isIgnored('$.a', ['']));
});
