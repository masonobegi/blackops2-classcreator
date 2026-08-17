import type { Database } from '../db.ts';
import { effectivePlan, type Plan } from '../plans.ts';
import {
  findUserById,
  listChannelsOldestFirst,
  listMonitors,
  listMonitorsOldestFirst,
  setMonitorStatus,
} from '../store.ts';

const PLAN_PAUSE_REASON = 'Plan limit reached';

/**
 * Bring a user's resources in line with the plan they are actually entitled to.
 *
 * Called after every billing event and once an hour by the scheduler, which is
 * what lets a customer cancel at 3am and have their account downgrade itself
 * without anyone being paged. Downgrades pause rather than delete: if they come
 * back, their monitors and history are exactly where they left them, which is
 * both kinder and much better for win-back revenue.
 */
export function applyEntitlements(
  db: Database,
  userId: string,
): { plan: Plan; paused: number; resumed: number; clamped: number; channelsDisabled: number } | null {
  const user = findUserById(db, userId);
  if (!user) return null;

  const plan = effectivePlan(user.plan, user.subscription_status);
  const monitors = listMonitorsOldestFirst(db, userId);

  let paused = 0;
  let resumed = 0;
  let clamped = 0;

  monitors.forEach((monitor, index) => {
    const overLimit = index >= plan.monitors;

    if (overLimit && monitor.status === 'active') {
      setMonitorStatus(db, monitor.id, 'paused', PLAN_PAUSE_REASON);
      paused++;
    } else if (!overLimit && monitor.status === 'paused' && monitor.pause_reason === PLAN_PAUSE_REASON) {
      // Only un-pause what *we* paused. A monitor the customer paused on
      // purpose stays paused when they upgrade.
      setMonitorStatus(db, monitor.id, 'active', null);
      resumed++;
    }

    if (monitor.interval_seconds < plan.minIntervalSeconds) {
      db.prepare('update monitors set interval_seconds = ?, updated_at = ? where id = ?').run(
        plan.minIntervalSeconds,
        Date.now(),
        monitor.id,
      );
      clamped++;
    }
  });

  let channelsDisabled = 0;
  const channels = listChannelsOldestFirst(db, userId);
  channels.forEach((channel, index) => {
    if (index >= plan.channels && channel.disabled_at === null) {
      db.prepare('update channels set disabled_at = ?, last_error = ? where id = ?').run(
        Date.now(),
        PLAN_PAUSE_REASON,
        channel.id,
      );
      channelsDisabled++;
    } else if (index < plan.channels && channel.disabled_at !== null && channel.last_error === PLAN_PAUSE_REASON) {
      db.prepare('update channels set disabled_at = null, last_error = null where id = ?').run(
        channel.id,
      );
    }
  });

  return { plan, paused, resumed, clamped, channelsDisabled };
}

/** Can this user add another monitor right now? */
export function canAddMonitor(db: Database, userId: string): { allowed: boolean; plan: Plan; used: number } {
  const user = findUserById(db, userId);
  const plan = effectivePlan(user?.plan ?? 'free', user?.subscription_status ?? null);
  const used = listMonitors(db, userId).length;
  return { allowed: used < plan.monitors, plan, used };
}
