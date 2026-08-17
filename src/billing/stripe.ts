import type { Config } from '../config.ts';
import { hmacHex, safeEqual } from '../lib/crypto.ts';
import type { PlanId } from '../plans.ts';

/**
 * A tiny Stripe client over `fetch`. The official SDK is excellent but this
 * service needs five endpoints, and zero dependencies means zero supply-chain
 * surface and no upgrade treadmill on a system meant to run untended.
 */

const API_BASE = 'https://api.stripe.com/v1';
/** Pinned so a Stripe-side default upgrade cannot change our parsing. */
const API_VERSION = '2024-06-20';

export class StripeError extends Error {}

/** Stripe takes form encoding with bracket syntax for nested values. */
export function encodeForm(data: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix === '' ? key : `${prefix}[${key}]`;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          parts.push(encodeForm(item as Record<string, unknown>, `${name}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === 'object') {
      parts.push(encodeForm(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter((part) => part !== '').join('&');
}

async function request<T>(
  config: Config,
  method: 'GET' | 'POST',
  path: string,
  data?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  if (!config.stripe.secretKey) throw new StripeError('Stripe is not configured');

  const headers: Record<string, string> = {
    authorization: `Bearer ${config.stripe.secretKey}`,
    'stripe-version': API_VERSION,
  };
  let url = `${API_BASE}${path}`;
  let body: string | undefined;

  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = data ? encodeForm(data) : '';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  } else if (data) {
    const query = encodeForm(data);
    if (query) url += `?${query}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; type?: string };
  };

  if (!response.ok) {
    throw new StripeError(
      payload.error?.message ?? `Stripe request failed with HTTP ${response.status}`,
    );
  }
  return payload as T;
}

export type StripeCustomer = { id: string };
export type StripeCheckoutSession = { id: string; url: string };
export type StripePortalSession = { id: string; url: string };

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  items: {
    data: { price: { id: string }; current_period_end?: number }[];
  };
  /** We stamp `driftwatch_user_id` here at checkout; used to attribute events. */
  metadata?: Record<string, string>;
};

export async function createCustomer(
  config: Config,
  email: string,
  userId: string,
): Promise<StripeCustomer> {
  return request<StripeCustomer>(
    config,
    'POST',
    '/customers',
    { email, metadata: { driftwatch_user_id: userId } },
    // Idempotent on the user id, so a double-clicked upgrade button cannot
    // create two customers for one account.
    `customer:${userId}`,
  );
}

export async function createCheckoutSession(
  config: Config,
  options: { customerId: string; priceId: string; userId: string; planId: PlanId },
): Promise<StripeCheckoutSession> {
  return request<StripeCheckoutSession>(config, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer: options.customerId,
    client_reference_id: options.userId,
    line_items: [{ price: options.priceId, quantity: 1 }],
    success_url: `${config.baseUrl}/billing/return?status=success`,
    cancel_url: `${config.baseUrl}/billing?status=cancelled`,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    subscription_data: {
      metadata: { driftwatch_user_id: options.userId, driftwatch_plan: options.planId },
    },
    metadata: { driftwatch_user_id: options.userId, driftwatch_plan: options.planId },
  });
}

/**
 * The Customer Portal is what makes this business hands-off: card updates,
 * plan changes, invoices and cancellations all happen on Stripe's pages.
 */
export async function createPortalSession(
  config: Config,
  customerId: string,
): Promise<StripePortalSession> {
  return request<StripePortalSession>(config, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: `${config.baseUrl}/billing`,
  });
}

export async function getSubscription(config: Config, id: string): Promise<StripeSubscription> {
  return request<StripeSubscription>(config, 'GET', `/subscriptions/${encodeURIComponent(id)}`);
}

/** Used to reconcile state when a webhook was missed or never configured. */
export async function listSubscriptions(
  config: Config,
  customerId: string,
): Promise<{ data: StripeSubscription[] }> {
  return request<{ data: StripeSubscription[] }>(config, 'GET', '/subscriptions', {
    customer: customerId,
    status: 'all',
    limit: 10,
  });
}

/**
 * Verify the `Stripe-Signature` header.
 *
 * Without this check anyone who finds the webhook URL can grant themselves the
 * Team plan by POSTing a fake `checkout.session.completed`.
 */
export function verifyWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; error: string } {
  if (!header) return { ok: false, error: 'missing signature header' };
  if (!secret) return { ok: false, error: 'webhook secret not configured' };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }

  if (timestamp === null || !Number.isFinite(timestamp)) {
    return { ok: false, error: 'malformed signature header' };
  }
  if (signatures.length === 0) return { ok: false, error: 'no v1 signature present' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, error: 'signature timestamp outside tolerance' };
  }

  const expected = hmacHex(secret, `${timestamp}.${payload}`);
  const matched = signatures.some((candidate) => safeEqual(candidate, expected));
  return matched ? { ok: true } : { ok: false, error: 'signature mismatch' };
}

/** Map a Stripe price back to one of our plans. */
export function planForPrice(config: Config, priceId: string | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === config.stripe.prices.pro) return 'pro';
  if (priceId === config.stripe.prices.team) return 'team';
  return null;
}

/**
 * Period end lives on the subscription in older API versions and on each
 * subscription item in newer ones, so read whichever is present.
 */
export function periodEndMs(subscription: StripeSubscription): number | null {
  const seconds =
    subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end ?? null;
  return seconds === null ? null : seconds * 1000;
}

export function priceIdOf(subscription: StripeSubscription): string | undefined {
  return subscription.items?.data?.[0]?.price?.id;
}
