import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeUrl,
  isPrivateAddress,
  sanitizeHeaders,
  UnsafeUrlError,
} from '../src/monitor/guard.ts';

test('reserved IPv4 ranges are private', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
  ]) {
    assert.ok(isPrivateAddress(address), `${address} should be private`);
  }
});

test('ordinary public IPv4 addresses are allowed', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
    assert.ok(!isPrivateAddress(address), `${address} should be public`);
  }
});

test('IPv6 loopback, link-local and unique-local are private', () => {
  for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1']) {
    assert.ok(isPrivateAddress(address), `${address} should be private`);
  }
});

test('IPv4-mapped IPv6 cannot smuggle a private address through', () => {
  assert.ok(isPrivateAddress('::ffff:127.0.0.1'));
  assert.ok(isPrivateAddress('::ffff:169.254.169.254'));
  assert.ok(!isPrivateAddress('::ffff:8.8.8.8'));
});

test('garbage is treated as private rather than allowed', () => {
  assert.ok(isPrivateAddress('not-an-ip'));
  assert.ok(isPrivateAddress('999.999.999.999'));
  assert.ok(isPrivateAddress(''));
});

test('non-http protocols are refused', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/']) {
    await assert.rejects(() => assertSafeUrl(url), UnsafeUrlError);
  }
});

test('localhost and cloud metadata hostnames are refused by name', async () => {
  for (const url of [
    'http://localhost/x',
    'http://foo.localhost/x',
    'http://metadata.google.internal/x',
    'http://svc.internal/x',
  ]) {
    await assert.rejects(() => assertSafeUrl(url), UnsafeUrlError);
  }
});

test('loopback and metadata IP literals are refused', async () => {
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:8080/x'), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl('http://[::1]/x'), UnsafeUrlError);
});

test('unusual ports are refused', async () => {
  await assert.rejects(() => assertSafeUrl('http://93.184.216.34:22/'), UnsafeUrlError);
  await assert.rejects(() => assertSafeUrl('http://93.184.216.34:6379/'), UnsafeUrlError);
});

test('a malformed URL is refused rather than coerced', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), UnsafeUrlError);
});

test('allowPrivate is an explicit opt-in that skips the checks', async () => {
  const url = await assertSafeUrl('http://127.0.0.1:45671/x', { allowPrivate: true });
  assert.equal(url.hostname, '127.0.0.1');
  // Protocol validation still applies even with the opt-in.
  await assert.rejects(
    () => assertSafeUrl('file:///etc/passwd', { allowPrivate: true }),
    UnsafeUrlError,
  );
});

test('headers we control cannot be overridden', () => {
  const clean = sanitizeHeaders({
    Host: 'evil.example.com',
    'Content-Length': '0',
    Connection: 'close',
    authorization: 'Bearer token',
  });
  assert.deepEqual(clean, { authorization: 'Bearer token' });
});

test('header injection attempts are dropped', () => {
  const clean = sanitizeHeaders({
    'x-ok': 'fine',
    'x-bad': 'value\r\nX-Injected: yes',
    'bad name': 'value',
    '': 'value',
  });
  assert.deepEqual(clean, { 'x-ok': 'fine' });
});

test('header values are truncated rather than unbounded', () => {
  const clean = sanitizeHeaders({ 'x-long': 'a'.repeat(10_000) });
  assert.equal(clean['x-long']!.length, 4096);
});
