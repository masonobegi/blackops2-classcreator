import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probe } from '../src/monitor/probe.ts';

type Handler = (res: ServerResponse, url: string) => void;

let handler: Handler = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
};

let server: Server;
let base = '';

test('probe', async (t) => {
  server = createServer((req, res) => handler(res, req.url ?? '/'));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = (overrides: Partial<Parameters<typeof probe>[1]> = {}) =>
    probe(
      { method: 'GET', url: `${base}/x`, headers: {}, body: null },
      { timeoutMs: 3000, maxBytes: 10_000, allowPrivateTargets: true, ...overrides },
    );

  await t.test('parses a JSON response', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"a":1,"b":[2]}');
    };
    const result = await run();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'application/json');
    assert.deepEqual(result.body, { a: 1, b: [2] });
    assert.ok(result.latencyMs >= 0);
  });

  await t.test('sniffs JSON served with the wrong content type', async () => {
    // Plenty of real APIs serve JSON as text/plain. Trusting the header alone
    // would make them permanently unmonitorable.
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('[{"a":1}]');
    };
    const result = await run();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.body, [{ a: 1 }]);
  });

  await t.test('treats HTML as a failed check, not an empty schema', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>maintenance</body></html>');
    };
    const result = await run();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not JSON/);
  });

  await t.test('malformed JSON fails rather than throwing', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1,');
    };
    const result = await run();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not valid JSON/);
  });

  await t.test('a 4xx with a JSON body is a successful observation', async () => {
    // An endpoint that starts returning 401 has changed its contract. That is
    // exactly what a customer wants to hear about, so it must not be swallowed
    // as a transport failure.
    handler = (res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"forbidden"}');
    };
    const result = await run();
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, 403);
  });

  await t.test('a 5xx is a failure so it cannot overwrite a baseline', async () => {
    handler = (res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"unavailable"}');
    };
    const result = await run();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
      assert.match(result.error, /HTTP 503/);
    }
  });

  await t.test('an empty body (204) is a failure, not an empty contract', async () => {
    handler = (res) => {
      res.writeHead(204);
      res.end();
    };
    const result = await run();
    assert.equal(result.ok, false);
  });

  await t.test('a declared oversized body is rejected before reading it', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(50_000) });
    handler = (res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(big)),
      });
      res.end(big);
    };
    const result = await run({ maxBytes: 1000 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too large/);
  });

  await t.test('an undeclared oversized body is cut off mid-stream', async () => {
    handler = (res) => {
      // Chunked, so there is no content-length to check up front.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[');
      for (let i = 0; i < 200; i++) res.write(`"${'x'.repeat(100)}",`);
      res.end('"end"]');
    };
    const result = await run({ maxBytes: 1000 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /exceeded/);
  });

  await t.test('redirects are followed', async () => {
    handler = (res, url) => {
      if (url === '/x') {
        res.writeHead(302, { location: '/moved' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"moved":true}');
    };
    const result = await run();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.body, { moved: true });
  });

  await t.test('a redirect loop terminates instead of hanging', async () => {
    handler = (res) => {
      res.writeHead(302, { location: '/x' });
      res.end();
    };
    const result = await run();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /redirects/);
  });

  await t.test('a redirect without a Location is reported clearly', async () => {
    handler = (res) => {
      res.writeHead(302);
      res.end();
    };
    const result = await run();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /without a Location/);
  });

  await t.test('a slow endpoint times out rather than blocking the scheduler', async () => {
    handler = () => {
      /* never respond */
    };
    const result = await run({ timeoutMs: 250 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /timed out/);
  });

  await t.test('request headers are sent, minus the ones we control', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const result = await probe(
      {
        method: 'GET',
        url: `${base}/x`,
        headers: { authorization: 'Bearer secret', Host: 'evil.example.com' },
        body: null,
      },
      { timeoutMs: 3000, maxBytes: 10_000, allowPrivateTargets: true },
    );
    assert.equal(result.ok, true);
    assert.equal(seen['authorization'], 'Bearer secret');
    assert.notEqual(seen['host'], 'evil.example.com');
    assert.match(String(seen['user-agent']), /Driftwatch/);
  });

  await t.test('the SSRF guard applies by default, with no opt-in', async () => {
    const result = await probe(
      { method: 'GET', url: `${base}/x`, headers: {}, body: null },
      { timeoutMs: 3000, maxBytes: 10_000 },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /^Blocked:/);
  });
});
