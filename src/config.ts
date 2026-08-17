import { randomBytes } from 'node:crypto';

export type EmailProvider = 'resend' | 'postmark' | 'none';

export type Config = {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  baseUrl: string;
  databasePath: string;
  sessionSecret: string;
  devLogin: boolean;
  email: {
    provider: EmailProvider;
    apiKey: string;
    from: string;
  };
  stripe: {
    secretKey: string;
    webhookSecret: string;
    prices: { pro: string; team: string };
    enabled: boolean;
  };
  /**
   * Whether to believe `X-Forwarded-For`. True is right behind Fly, Railway,
   * Render or any reverse proxy; false when the process is directly exposed,
   * where a client could otherwise spoof the header to reset its rate limits.
   */
  trustProxy: boolean;
  scheduler: {
    enabled: boolean;
    tickMs: number;
    concurrency: number;
  };
  probe: {
    maxBytes: number;
    timeoutMs: number;
    allowPrivateTargets: boolean;
  };
};

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(): Config {
  const nodeEnv = env('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const stripeSecret = env('STRIPE_SECRET_KEY');
  const config: Config = {
    nodeEnv,
    isProduction,
    port: envInt('PORT', 8080),
    baseUrl: env('BASE_URL', `http://localhost:${envInt('PORT', 8080)}`).replace(/\/+$/, ''),
    databasePath: env('DATABASE_PATH', './data/driftwatch.db'),
    sessionSecret: env('SESSION_SECRET'),
    devLogin: envBool('DRIFTWATCH_DEV_LOGIN', false),
    email: {
      provider: env('EMAIL_PROVIDER', 'none') as EmailProvider,
      apiKey: env('EMAIL_API_KEY'),
      from: env('EMAIL_FROM', 'Driftwatch <alerts@example.com>'),
    },
    stripe: {
      secretKey: stripeSecret,
      webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
      prices: { pro: env('STRIPE_PRICE_PRO'), team: env('STRIPE_PRICE_TEAM') },
      enabled: stripeSecret !== '',
    },
    trustProxy: envBool('TRUST_PROXY', true),
    scheduler: {
      enabled: envBool('SCHEDULER_ENABLED', true),
      tickMs: envInt('SCHEDULER_TICK_MS', 10_000),
      concurrency: envInt('SCHEDULER_CONCURRENCY', 8),
    },
    probe: {
      maxBytes: envInt('PROBE_MAX_BYTES', 2_000_000),
      timeoutMs: envInt('PROBE_TIMEOUT_MS', 15_000),
      allowPrivateTargets: envBool('PROBE_ALLOW_PRIVATE_TARGETS', false),
    },
  };

  const problems: string[] = [];
  if (!config.sessionSecret) {
    if (isProduction) {
      problems.push('SESSION_SECRET is required in production.');
    } else {
      // Ephemeral secret keeps local development frictionless; sessions reset on restart.
      config.sessionSecret = randomBytes(32).toString('hex');
    }
  }
  if (isProduction && config.devLogin) {
    problems.push('DRIFTWATCH_DEV_LOGIN must be off in production.');
  }
  if (isProduction && !config.baseUrl.startsWith('https://')) {
    problems.push('BASE_URL must be an https:// origin in production.');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }

  return config;
}
