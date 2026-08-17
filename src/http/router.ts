import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Raw } from '../lib/html.ts';

const MAX_BODY_BYTES = 1_000_000;

export type Reply = {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
};

export type RequestContext = {
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  cookies: Record<string, string>;
  ip: string;
  /** Raw request body, read at most once and cached. */
  text: () => Promise<string>;
  form: () => Promise<URLSearchParams>;
  json: <T>() => Promise<T | null>;
};

export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

type Route = {
  method: string;
  segments: string[];
  handler: Handler;
};

// ------------------------------------------------------------- responses -----

export function htmlReply(body: Raw | string, status = 200): Reply {
  const text = typeof body === 'string' ? body : body.__raw;
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The UI ships no third-party scripts, so lock the page down hard.
      // `form-action` must name the Stripe hosts. Chrome and Safari apply this
      // directive to the *redirect target* of a form submission, not just the
      // immediate action, so a bare 'self' silently blocks the hop from
      // POST /billing/checkout to Stripe Checkout — meaning nobody can pay.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
        "form-action 'self' https://checkout.stripe.com https://billing.stripe.com; " +
        "base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
    body: text,
  };
}

export function jsonReply(payload: unknown, status = 200): Reply {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(payload, null, 2),
  };
}

export function textReply(body: string, status = 200): Reply {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body };
}

export function redirect(location: string, status = 303): Reply {
  return { status, headers: { location }, body: '' };
}

export function withCookie(reply: Reply, cookie: string): Reply {
  const existing = reply.headers['set-cookie'];
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  return { ...reply, headers: { ...reply.headers, 'set-cookie': [...list, cookie] } };
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; secure: boolean; httpOnly?: boolean; path?: string } = { secure: false },
): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`, 'SameSite=Lax'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------- router -----

export function createRouter() {
  const routes: Route[] = [];
  let fallback: Handler = () => textReply('Not found', 404);

  function add(method: string, pattern: string, handler: Handler): void {
    routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i]!;
        const value = parts[i]!;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  return {
    get: (pattern: string, handler: Handler) => add('GET', pattern, handler),
    post: (pattern: string, handler: Handler) => add('POST', pattern, handler),
    delete: (pattern: string, handler: Handler) => add('DELETE', pattern, handler),
    setFallback: (handler: Handler) => {
      fallback = handler;
    },
    match,
    resolve(method: string, path: string): { handler: Handler; params: Record<string, string> } {
      // HEAD is served by the GET handler with the body dropped later.
      const found = match(method === 'HEAD' ? 'GET' : method, path);
      return found ?? { handler: fallback, params: {} };
    },
  };
}

export type Router = ReturnType<typeof createRouter>;

// ------------------------------------------------------------- plumbing ------

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name !== '') jar[name] = decodeURIComponent(value);
  }
  return jar;
}

/** Thrown when a request body exceeds the cap, so the server can answer 413. */
export class PayloadTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(`request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function buildContext(
  req: IncomingMessage,
  baseUrl: string,
  params: Record<string, string>,
  trustProxy = true,
): RequestContext {
  const url = new URL(req.url ?? '/', baseUrl);
  let cached: Promise<string> | null = null;
  const text = () => {
    cached ??= readBody(req);
    return cached;
  };

  return {
    method: req.method ?? 'GET',
    url,
    path: url.pathname,
    params,
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie),
    ip:
      (trustProxy
        ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        : undefined) ??
      req.socket.remoteAddress ??
      'unknown',
    text,
    form: async () => new URLSearchParams(await text()),
    json: async <T>() => {
      try {
        return JSON.parse(await text()) as T;
      } catch {
        return null;
      }
    },
  };
}

export function send(res: ServerResponse, reply: Reply, isHead: boolean): void {
  res.writeHead(reply.status, reply.headers);
  if (isHead) {
    res.end();
    return;
  }
  res.end(reply.body);
}
