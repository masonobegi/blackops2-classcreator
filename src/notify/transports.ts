import type { Config } from '../config.ts';
import { hmacHex } from '../lib/crypto.ts';

export type SendResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

const SEND_TIMEOUT_MS = 15_000;

/**
 * A 4xx means the destination is wrong (bad address, revoked Slack hook) and
 * retrying is pointless; 408/429 and 5xx are worth another go. Getting this
 * split right is the difference between a queue that drains and one that
 * hammers a dead endpoint forever.
 */
function classify(status: number): { retryable: boolean } {
  if (status === 408 || status === 429 || status >= 500) return { retryable: true };
  return { retryable: false };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<SendResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return {
      ok: false,
      error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      retryable: classify(response.status).retryable,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, retryable: true };
  }
}

// ------------------------------------------------------------------ email ----

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendEmail(config: Config, message: EmailMessage): Promise<SendResult> {
  switch (config.email.provider) {
    case 'resend':
      return postJson(
        'https://api.resend.com/emails',
        {
          from: config.email.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        { authorization: `Bearer ${config.email.apiKey}` },
      );

    case 'postmark':
      return postJson(
        'https://api.postmarkapp.com/email',
        {
          From: config.email.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: 'outbound',
        },
        { 'x-postmark-server-token': config.email.apiKey, accept: 'application/json' },
      );

    case 'none':
    default:
      // Local development: print instead of sending, so the whole flow is
      // exercisable without signing up for anything.
      console.log(
        `\n──── email ────\nto:      ${message.to}\nsubject: ${message.subject}\n\n${message.text}\n───────────────\n`,
      );
      return { ok: true };
  }
}

// ------------------------------------------------------------------ slack ----

export async function sendSlack(webhookUrl: string, payload: unknown): Promise<SendResult> {
  return postJson(webhookUrl, payload, {});
}

// ---------------------------------------------------------------- webhook ----

/**
 * Signed like a Stripe webhook: `t=<unix>,v1=<hmac(t.body)>`. Receivers can
 * verify authenticity and reject replays without needing mTLS or IP allowlists.
 */
export async function sendWebhook(
  url: string,
  payload: unknown,
  secret: string | null,
): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Driftwatch/1.0',
  };
  if (secret) {
    headers['driftwatch-signature'] = `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return {
      ok: false,
      error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      retryable: classify(response.status).retryable,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, retryable: true };
  }
}
