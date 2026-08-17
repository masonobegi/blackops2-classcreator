import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import {
  claimStripeEvent,
  findUserById,
  findUserByStripeCustomer,
  setUserBilling,
} from '../store.ts';
import {
  getSubscription,
  listSubscriptions,
  periodEndMs,
  planForPrice,
  priceIdOf,
  type StripeSubscription,
} from './stripe.ts';
import { applyEntitlements } from './entitlements.ts';

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

export type WebhookOutcome = {
  handled: boolean;
  detail: string;
};

/**
 * Apply a verified Stripe event to our own records.
 *
 * Stripe is the source of truth for money; this database is the source of truth
 * for access. Everything that moves between them moves through here, and it is
 * idempotent because Stripe retries events for up to three days.
 */
export async function handleStripeEvent(
  db: Database,
  config: Config,
  event: StripeEvent,
): Promise<WebhookOutcome> {
  if (!claimStripeEvent(db, event.id, event.type)) {
    return { handled: true, detail: `duplicate event ${event.id} ignored` };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as {
        client_reference_id?: string;
        customer?: string;
        subscription?: string;
        metadata?: { driftwatch_user_id?: string };
      };
      const userId = session.client_reference_id ?? session.metadata?.driftwatch_user_id;
      if (!userId || !findUserById(db, userId)) {
        return { handled: false, detail: 'checkout session had no known user' };
      }
      if (session.customer) {
        setUserBilling(db, userId, { stripeCustomerId: session.customer });
      }
      if (!session.subscription) {
        return { handled: true, detail: 'checkout completed without a subscription' };
      }
      // Fetch rather than trust: the session payload does not carry the price.
      const subscription = await getSubscription(config, session.subscription);
      return applySubscriptionToUser(db, config, userId, subscription);
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.resumed':
    case 'customer.subscription.paused': {
      const subscription = normalizeSubscription(event.data.object);
      const user = resolveUser(db, subscription);
      if (!user) return { handled: false, detail: 'no user for subscription customer' };
      return applySubscriptionToUser(db, config, user, subscription);
    }

    case 'customer.subscription.deleted': {
      const subscription = normalizeSubscription(event.data.object);
      const userId = resolveUser(db, subscription);
      if (!userId) return { handled: false, detail: 'no user for cancelled subscription' };
      setUserBilling(db, userId, {
        plan: 'free',
        subscriptionStatus: 'canceled',
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
      });
      applyEntitlements(db, userId);
      return { handled: true, detail: `user ${userId} downgraded to free` };
    }

    default:
      return { handled: true, detail: `no action for ${event.type}` };
  }
}

/**
 * Reconcile a user against Stripe directly, without waiting for an event.
 *
 * Called right after checkout (so a paying customer never stares at the Free
 * plan while a webhook is in flight) and available as a manual repair path if
 * webhook delivery was broken during a deploy.
 */
export async function syncCustomerSubscription(
  db: Database,
  config: Config,
  userId: string,
): Promise<WebhookOutcome> {
  const user = findUserById(db, userId);
  if (!user?.stripe_customer_id) {
    return { handled: false, detail: 'user has no Stripe customer' };
  }

  const list = await listSubscriptions(config, user.stripe_customer_id);
  const live = list.data.find((subscription) =>
    ['active', 'trialing', 'past_due'].includes(subscription.status),
  );

  if (!live) {
    setUserBilling(db, userId, {
      plan: 'free',
      subscriptionStatus: list.data[0]?.status ?? 'canceled',
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    });
    applyEntitlements(db, userId);
    return { handled: true, detail: `no live subscription for ${userId}; on free plan` };
  }

  return applySubscriptionToUser(db, config, userId, live);
}

function normalizeSubscription(object: Record<string, unknown>): StripeSubscription {
  const customer = object['customer'];
  return {
    id: String(object['id'] ?? ''),
    status: String(object['status'] ?? ''),
    // `customer` is a string id when not expanded, an object when it is.
    customer:
      typeof customer === 'string'
        ? customer
        : String((customer as { id?: string } | undefined)?.id ?? ''),
    current_period_end: object['current_period_end'] as number | undefined,
    cancel_at_period_end: object['cancel_at_period_end'] as boolean | undefined,
    items: (object['items'] as StripeSubscription['items']) ?? { data: [] },
    metadata: object['metadata'] as Record<string, string> | undefined,
  };
}

/**
 * Map a subscription back to an account, by customer id and then by the
 * metadata we stamped on it at checkout.
 *
 * The metadata fallback matters because subscription events can arrive before
 * (or instead of) the checkout session that would have recorded the customer
 * id — and an event we cannot attribute is a customer who paid and got nothing.
 */
function resolveUser(db: Database, subscription: StripeSubscription): string | null {
  if (subscription.customer) {
    const byCustomer = findUserByStripeCustomer(db, subscription.customer);
    if (byCustomer) return byCustomer.id;
  }

  const fromMetadata = subscription.metadata?.['driftwatch_user_id'];
  if (fromMetadata && findUserById(db, fromMetadata)) return fromMetadata;

  return null;
}

function applySubscriptionToUser(
  db: Database,
  config: Config,
  userId: string,
  subscription: StripeSubscription,
): WebhookOutcome {
  const planId = planForPrice(config, priceIdOf(subscription));
  if (!planId) {
    // A price we do not recognise: record the status but do not guess at access.
    setUserBilling(db, userId, {
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: periodEndMs(subscription),
    });
    applyEntitlements(db, userId);
    return { handled: false, detail: `unrecognised price on subscription ${subscription.id}` };
  }

  setUserBilling(db, userId, {
    plan: planId,
    stripeCustomerId: subscription.customer || undefined,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: periodEndMs(subscription),
  });
  const result = applyEntitlements(db, userId);

  return {
    handled: true,
    detail: `user ${userId} -> ${planId} (${subscription.status}); resumed ${result?.resumed ?? 0}, paused ${result?.paused ?? 0}`,
  };
}
