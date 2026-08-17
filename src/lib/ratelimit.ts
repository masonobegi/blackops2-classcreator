/**
 * Fixed-window in-memory rate limiter.
 *
 * Used on the endpoints that cost money or annoy strangers: sending login
 * emails, and creating monitors. In-memory is the right trade here — a single
 * process serves the whole app, and a limiter that loses its state on deploy is
 * far better than a dependency on Redis for a service that must run untended.
 */

export type RateLimiter = {
  check: (key: string) => { allowed: boolean; retryAfterSeconds: number };
  reset: (key: string) => void;
};

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = options.maxKeys ?? 10_000;

  return {
    check(key: string) {
      const now = Date.now();
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= now) {
        // Opportunistic sweep keeps the map from growing without bound under
        // a spray of distinct keys.
        if (windows.size >= maxKeys) {
          for (const [candidate, window] of windows) {
            if (window.resetAt <= now) windows.delete(candidate);
          }
          if (windows.size >= maxKeys) windows.clear();
        }
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (existing.count >= options.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        };
      }

      existing.count++;
      return { allowed: true, retryAfterSeconds: 0 };
    },

    reset(key: string) {
      windows.delete(key);
    },
  };
}
