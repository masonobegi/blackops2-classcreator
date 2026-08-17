import { sanitizeHeaders } from '../monitor/guard.ts';
import { clamp } from '../lib/util.ts';
import type { Plan } from '../plans.ts';
import type { Severity } from '../schema/diff.ts';
import { parseIgnorePaths } from '../schema/paths.ts';

export type MonitorInput = {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  intervalSeconds: number;
  ignorePaths: string[];
  minSeverity: Severity | null;
  confirmations: number;
};

export type ValidationResult =
  | { ok: true; value: MonitorInput }
  | { ok: false; errors: string[] };

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'HEAD']);
const SEVERITIES = new Set(['breaking', 'warning', 'info']);

/** Parse a `Name: value` block into a header map, dropping malformed lines. */
export function parseHeaderLines(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf(':');
    if (index < 1) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name !== '' && value !== '') headers[name] = value;
  }
  return sanitizeHeaders(headers);
}

export function parseSeverity(value: string | null | undefined): Severity | null {
  return value && SEVERITIES.has(value) ? (value as Severity) : null;
}

/**
 * Validate a monitor definition from either the web form or the REST API.
 *
 * Deep URL safety (DNS resolution, reserved ranges) is enforced by the probe
 * guard on every request, not just at save time, because DNS can change after
 * a monitor is created.
 */
export function validateMonitor(
  input: {
    name?: string | null;
    method?: string | null;
    url?: string | null;
    headers?: Record<string, string> | string | null;
    body?: string | null;
    intervalSeconds?: number | string | null;
    ignorePaths?: string[] | string | null;
    minSeverity?: string | null;
    confirmations?: number | string | null;
  },
  plan: Plan,
): ValidationResult {
  const errors: string[] = [];

  const name = (input.name ?? '').trim().slice(0, 120);
  if (name === '') errors.push('Name is required.');

  const method = (input.method ?? 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    errors.push(`Method must be one of ${[...ALLOWED_METHODS].join(', ')}.`);
  }

  const rawUrl = (input.url ?? '').trim();
  let url = '';
  if (rawUrl === '') {
    errors.push('URL is required.');
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('URL must use http or https.');
      } else {
        url = parsed.toString();
      }
    } catch {
      errors.push('URL is not valid.');
    }
  }

  const headers =
    typeof input.headers === 'string'
      ? parseHeaderLines(input.headers)
      : sanitizeHeaders(input.headers ?? {});

  const bodyRaw = (input.body ?? '').toString();
  const body = bodyRaw.trim() === '' ? null : bodyRaw.slice(0, 100_000);

  const requestedInterval = Number(input.intervalSeconds ?? plan.minIntervalSeconds);
  const intervalSeconds = Number.isFinite(requestedInterval)
    ? clamp(Math.round(requestedInterval), plan.minIntervalSeconds, 86_400)
    : plan.minIntervalSeconds;

  const ignorePaths = Array.isArray(input.ignorePaths)
    ? input.ignorePaths.map((path) => String(path).trim()).filter((path) => path !== '').slice(0, 100)
    : parseIgnorePaths(String(input.ignorePaths ?? ''));

  const minSeverity = parseSeverity(input.minSeverity);

  const requestedConfirmations = Number(input.confirmations ?? 2);
  const confirmations = Number.isFinite(requestedConfirmations)
    ? clamp(Math.round(requestedConfirmations), 1, 5)
    : 2;

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { name, method, url, headers, body, intervalSeconds, ignorePaths, minSeverity, confirmations },
  };
}

export type ChannelInput = { kind: 'email' | 'slack' | 'webhook'; target: string };

export function validateChannel(
  kind: string | null,
  target: string | null,
): { ok: true; value: ChannelInput } | { ok: false; error: string } {
  const cleanTarget = (target ?? '').trim();
  if (cleanTarget === '') return { ok: false, error: 'A destination is required.' };

  if (kind === 'email') {
    if (!/^[^\s@]{1,64}@[^\s@.]+\.[^\s@]{2,}$/.test(cleanTarget)) {
      return { ok: false, error: 'That is not a valid email address.' };
    }
    return { ok: true, value: { kind: 'email', target: cleanTarget.toLowerCase() } };
  }

  if (kind === 'slack' || kind === 'webhook') {
    let parsed: URL;
    try {
      parsed = new URL(cleanTarget);
    } catch {
      return { ok: false, error: 'That is not a valid URL.' };
    }
    // Alert destinations must be https: they carry response-shape details, and
    // in the Slack case a credential in the URL itself.
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'Webhook URLs must use https.' };
    }
    if (kind === 'slack' && !parsed.hostname.endsWith('slack.com')) {
      return { ok: false, error: 'Slack webhooks must be a hooks.slack.com URL.' };
    }
    return { ok: true, value: { kind, target: parsed.toString() } };
  }

  return { ok: false, error: 'Unknown channel type.' };
}
