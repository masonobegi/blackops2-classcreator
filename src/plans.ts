/**
 * Plan definitions. These are the only place pricing and limits live; the
 * scheduler, the API and the UI all read entitlements from here so a customer
 * downgrading in Stripe is enforced everywhere without any manual work.
 */

export type PlanId = 'free' | 'pro' | 'team';

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in whole US dollars. Mirrors the Stripe Price object. */
  priceUsd: number;
  /** Maximum active monitors. Monitors beyond the limit are auto-paused. */
  monitors: number;
  /** Fastest polling interval the plan allows, in seconds. */
  minIntervalSeconds: number;
  /** How long snapshots are retained before the pruner deletes them. */
  historyDays: number;
  /** Maximum notification channels. */
  channels: number;
  /** Whether the REST API and API keys are available. */
  apiAccess: boolean;
  blurb: string;
  features: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    monitors: 2,
    minIntervalSeconds: 3600,
    historyDays: 7,
    channels: 1,
    apiAccess: false,
    blurb: 'Watch a couple of critical endpoints.',
    features: [
      '2 monitors',
      'Hourly checks',
      '7 days of schema history',
      'Email alerts',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 19,
    monitors: 25,
    minIntervalSeconds: 300,
    historyDays: 90,
    channels: 5,
    apiAccess: true,
    blurb: 'For a team that integrates a handful of vendors.',
    features: [
      '25 monitors',
      'Checks every 5 minutes',
      '90 days of schema history',
      'Slack + webhook alerts',
      'REST API and API keys',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceUsd: 79,
    monitors: 150,
    minIntervalSeconds: 60,
    historyDays: 365,
    channels: 25,
    apiAccess: true,
    blurb: 'For platforms whose product is other people’s APIs.',
    features: [
      '150 monitors',
      'Checks every minute',
      '1 year of schema history',
      'Slack + webhook alerts',
      'REST API and API keys',
      'Per-monitor alert routing',
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'pro', 'team'];

export function getPlan(id: string | null | undefined): Plan {
  if (id === 'pro' || id === 'team' || id === 'free') return PLANS[id];
  return PLANS.free;
}

/**
 * Subscription statuses that still entitle the customer to their paid plan.
 * `past_due` is included deliberately: Stripe retries the charge for a couple
 * of weeks, and cutting service off on day one costs more churn than it saves.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function isEntitled(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && ENTITLED_STATUSES.has(status);
}

/** The plan a user is actually entitled to, given their subscription state. */
export function effectivePlan(planId: string | null, status: string | null): Plan {
  if (planId === 'free' || planId === null) return PLANS.free;
  return isEntitled(status) ? getPlan(planId) : PLANS.free;
}
