import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import { severityAtLeast, type Severity } from '../schema/diff.ts';
import {
  claimPendingDeliveries,
  enqueueDeliveries,
  getDeliveryContext,
  listActiveChannels,
  markDeliveryFailed,
  markDeliverySent,
  recordChannelError,
  type IncidentRow,
  type MonitorRow,
  type UserRow,
} from '../store.ts';
import { renderAlert } from './render.ts';
import { sendEmail, sendSlack, sendWebhook, type SendResult } from './transports.ts';

/** Backoff schedule in milliseconds, indexed by attempt number. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/**
 * Decide which channels should hear about an incident and queue the sends.
 *
 * Queueing rather than sending inline means a slow Slack endpoint cannot stall
 * the scheduler, and a transient failure gets retried instead of vanishing.
 */
export function queueIncidentNotifications(
  db: Database,
  incident: IncidentRow,
  monitor: MonitorRow,
  user: UserRow,
): number {
  const threshold = (monitor.min_severity ?? user.alert_min_severity) as Severity;

  // Recovery notices always go out. Being told an endpoint broke and never
  // being told it healed is worse than not being told at all.
  const bypassThreshold = incident.kind === 'recovery';
  if (!bypassThreshold && !severityAtLeast(incident.severity as Severity, threshold)) {
    return 0;
  }

  const channels = listActiveChannels(db, user.id);
  if (channels.length === 0) return 0;

  enqueueDeliveries(
    db,
    incident.id,
    channels.map((channel) => channel.id),
  );
  return channels.length;
}

/**
 * Drain the delivery queue. Called on every scheduler tick; safe to call
 * concurrently because claiming a delivery moves its next attempt forward.
 */
export async function runDeliveryQueue(
  db: Database,
  config: Config,
  limit = 25,
): Promise<{ sent: number; failed: number; retrying: number }> {
  const now = Date.now();
  const claimed = claimPendingDeliveries(db, now, limit);
  let sent = 0;
  let failed = 0;
  let retrying = 0;

  await Promise.all(
    claimed.map(async (delivery) => {
      const context = getDeliveryContext(db, delivery);
      if (!context) {
        markDeliveryFailed(db, delivery.id, 'incident or channel no longer exists', null);
        failed++;
        return;
      }

      const { incident, channel, monitor } = context;
      const alert = renderAlert(incident, monitor, config.baseUrl);

      let result: SendResult;
      switch (channel.kind) {
        case 'email':
          result = await sendEmail(config, {
            to: channel.target,
            subject: alert.subject,
            text: alert.text,
            html: alert.html,
          });
          break;
        case 'slack':
          result = await sendSlack(channel.target, alert.slack);
          break;
        case 'webhook':
          result = await sendWebhook(channel.target, alert.json, channel.secret);
          break;
        default:
          result = { ok: false, error: `unknown channel kind ${channel.kind}`, retryable: false };
      }

      if (result.ok) {
        markDeliverySent(db, delivery.id);
        recordChannelError(db, channel.id, null);
        sent++;
        return;
      }

      recordChannelError(db, channel.id, result.error);
      const attempts = delivery.attempts; // already incremented by the claim
      const backoff = BACKOFF_MS[attempts - 1];
      if (!result.retryable || attempts >= MAX_ATTEMPTS || backoff === undefined) {
        markDeliveryFailed(db, delivery.id, result.error, null);
        failed++;
      } else {
        markDeliveryFailed(db, delivery.id, result.error, Date.now() + backoff);
        retrying++;
      }
    }),
  );

  return { sent, failed, retrying };
}

/** Send the magic-link login email. */
export async function sendLoginEmail(
  config: Config,
  email: string,
  url: string,
): Promise<SendResult> {
  return sendEmail(config, {
    to: email,
    subject: 'Your Driftwatch sign-in link',
    text: `Sign in to Driftwatch:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not request it, ignore this email.`,
    html: `
<div style="background:#0f1115;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#16181d;border:1px solid #22252b;border-radius:12px;padding:28px 24px">
    <div style="font:600 18px/1.3 inherit;color:#f4f5f7">Sign in to Driftwatch</div>
    <p style="margin:12px 0 24px;font:14px/1.6 inherit;color:#a8adb8">
      This link works once and expires in 20 minutes.
    </p>
    <a href="${url}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#4f7cff;color:#fff;font:600 14px/1 inherit;text-decoration:none">
      Sign in
    </a>
    <p style="margin:24px 0 0;font:12px/1.6 inherit;color:#6b7280">
      If you did not request this, you can ignore the email.
    </p>
  </div>
</div>`.trim(),
  });
}
