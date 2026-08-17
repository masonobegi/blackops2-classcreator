import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import { safeEqual } from '../lib/crypto.ts';
import { findSession, findUserByApiKey, type UserRow } from '../store.ts';
import { serializeCookie, type RequestContext } from './router.ts';

export const SESSION_COOKIE = 'dw_session';

export type Auth = { user: UserRow; csrf: string };

export function currentAuth(db: Database, ctx: RequestContext): Auth | null {
  const token = ctx.cookies[SESSION_COOKIE];
  if (!token) return null;
  return findSession(db, token);
}

/** Bearer-token auth for the REST API. */
export function apiAuth(db: Database, ctx: RequestContext): UserRow | null {
  const header = ctx.headers.authorization;
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token.startsWith('dw_live_')) return null;
  return findUserByApiKey(db, token);
}

export function sessionCookie(config: Config, token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    secure: config.baseUrl.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(config: Config): string {
  return serializeCookie(SESSION_COOKIE, '', {
    secure: config.baseUrl.startsWith('https://'),
    maxAge: 0,
  });
}

/**
 * Every state-changing form carries the session's CSRF token.
 *
 * SameSite=Lax already blocks most cross-site POSTs, but it is a browser
 * policy, not a guarantee, and the cost of a second check is one hidden input.
 */
export function checkCsrf(auth: Auth, form: URLSearchParams): boolean {
  const supplied = form.get('csrf');
  return typeof supplied === 'string' && supplied !== '' && safeEqual(supplied, auth.csrf);
}
