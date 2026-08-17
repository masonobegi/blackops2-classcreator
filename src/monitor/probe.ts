import { assertSafeUrl, sanitizeHeaders, UnsafeUrlError } from './guard.ts';

export type ProbeSuccess = {
  ok: true;
  status: number;
  contentType: string;
  latencyMs: number;
  body: unknown;
  bytes: number;
};

export type ProbeFailure = {
  ok: false;
  status: number | null;
  contentType: string | null;
  latencyMs: number | null;
  error: string;
};

export type ProbeOutcome = ProbeSuccess | ProbeFailure;

export type ProbeRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

export type ProbeOptions = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  userAgent?: string;
  /** See `UrlGuardOptions.allowPrivate` — off unless explicitly configured. */
  allowPrivateTargets?: boolean;
};

/**
 * A probe "fails" when we learned nothing about the contract:
 *   - transport error, DNS failure or timeout
 *   - 5xx, which is the upstream having a bad day rather than a new contract
 *   - a body that is not JSON
 * Failures never overwrite the baseline. A 4xx *is* a success for our purposes:
 * an endpoint that starts returning 401 has changed its contract, and that is
 * exactly the kind of thing a customer wants to be woken up for.
 */
export async function probe(
  request: ProbeRequest,
  options: ProbeOptions,
): Promise<ProbeOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const maxRedirects = options.maxRedirects ?? 3;

  let target: string = request.url;
  let redirects = 0;

  try {
    for (;;) {
      const url = await assertSafeUrl(target, { allowPrivate: options.allowPrivateTargets });
      const response = await fetchOnce(url, request, options, redirects > 0);

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        // Drain the redirect body so the socket can be reused.
        await response.body?.cancel();
        if (!location) {
          return fail(response.status, response.headers.get('content-type'), elapsed(), 'Redirect without a Location header');
        }
        if (redirects >= maxRedirects) {
          return fail(response.status, response.headers.get('content-type'), elapsed(), `More than ${maxRedirects} redirects`);
        }
        redirects++;
        target = new URL(location, url).toString();
        continue;
      }

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

      if (response.status >= 500) {
        await response.body?.cancel();
        return fail(response.status, contentType, elapsed(), `Upstream returned HTTP ${response.status}`);
      }

      const read = await readCapped(response, options.maxBytes);
      if (!read.ok) return fail(response.status, contentType, elapsed(), read.error);

      if (!looksLikeJson(contentType, read.text)) {
        return fail(response.status, contentType, elapsed(), `Response was not JSON (content-type: ${contentType || 'none'})`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(read.text);
      } catch (error) {
        return fail(response.status, contentType, elapsed(), `Response was not valid JSON: ${(error as Error).message}`);
      }

      return {
        ok: true,
        status: response.status,
        contentType,
        latencyMs: elapsed(),
        body: parsed,
        bytes: read.bytes,
      };
    }
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return fail(null, null, elapsed(), `Blocked: ${error.message}`);
    }
    return fail(null, null, elapsed(), describeError(error));
  }
}

function fail(
  status: number | null,
  contentType: string | null,
  latencyMs: number,
  error: string,
): ProbeFailure {
  return { ok: false, status, contentType, latencyMs, error };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchOnce(
  url: URL,
  request: ProbeRequest,
  options: ProbeOptions,
  isRedirectHop: boolean,
): Promise<Response> {
  const headers = new Headers(sanitizeHeaders(request.headers));
  if (!headers.has('accept')) headers.set('accept', 'application/json, */*;q=0.5');
  headers.set('user-agent', options.userAgent ?? 'Driftwatch/1.0 (+https://driftwatch.dev/bot)');

  const method = request.method.toUpperCase();
  const sendBody = request.body !== null && request.body !== '' && method !== 'GET' && method !== 'HEAD';

  return fetch(url, {
    method,
    headers,
    // Credentials in customer-supplied headers must not follow a redirect to a
    // host the customer did not name, so we re-validate each hop ourselves.
    redirect: 'manual',
    body: sendBody && !isRedirectHop ? request.body : undefined,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

type ReadResult = { ok: true; text: string; bytes: number } | { ok: false; error: string };

/** Read at most `maxBytes`, aborting a response that tries to flood us. */
async function readCapped(response: Response, maxBytes: number): Promise<ReadResult> {
  if (!response.body) return { ok: true, text: '', bytes: 0 };

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    return { ok: false, error: `Response too large (${declared} bytes, limit ${maxBytes})` };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, error: `Response exceeded ${maxBytes} bytes` };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }

  return { ok: true, text: Buffer.concat(chunks).toString('utf8'), bytes: total };
}

/**
 * Plenty of real APIs serve JSON as text/plain or with no content type at all,
 * so sniff the payload rather than trusting the header alone.
 */
function looksLikeJson(contentType: string, text: string): boolean {
  if (contentType.includes('json')) return true;
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Request timed out';
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${error.message} (${cause.code})`;
    return error.message;
  }
  return String(error);
}
