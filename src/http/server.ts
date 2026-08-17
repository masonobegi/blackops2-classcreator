import { createServer as createHttpServer, type Server } from 'node:http';
import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import type { Scheduler } from '../monitor/scheduler.ts';
import { registerApiRoutes } from './api.ts';
import { registerWebRoutes } from './web.ts';
import { buildContext, createRouter, PayloadTooLargeError, send, textReply } from './router.ts';

export type ServerDeps = {
  db: Database;
  config: Config;
  scheduler: Scheduler;
};

export function createApp(deps: ServerDeps): Server {
  const router = createRouter();
  // API routes register first so `/api/*` and `/webhooks/*` win over the
  // catch-all HTML fallback.
  registerApiRoutes(router, deps);
  registerWebRoutes(router, deps);

  return createHttpServer(async (req, res) => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    let path = '/';

    try {
      const url = new URL(req.url ?? '/', deps.config.baseUrl);
      path = url.pathname;
      const { handler, params } = router.resolve(method, path);
      const ctx = buildContext(req, deps.config.baseUrl, params, deps.config.trustProxy);
      const reply = await handler(ctx);
      send(res, reply, method === 'HEAD');

      if (reply.status >= 400 || path.startsWith('/api/') || path.startsWith('/webhooks/')) {
        console.log(
          `${method} ${path} ${reply.status} ${Math.round(performance.now() - started)}ms`,
        );
      }
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        // An oversized body is the client's mistake, not ours, and is not worth
        // an error-log line. The rest of it is still arriving and we are not
        // going to read it, so the connection cannot be reused: without closing
        // it, the unread bytes are parsed as the start of the next request and
        // the following request on that socket hangs.
        const reply = textReply('Request body too large', 413);
        reply.headers['connection'] = 'close';
        res.once('finish', () => req.destroy());
        send(res, reply, method === 'HEAD');
        return;
      }
      // A handler throwing must not take the process down or leak a stack trace.
      console.error(`${method} ${path} failed:`, error);
      if (!res.headersSent) {
        send(res, textReply('Internal server error', 500), method === 'HEAD');
      } else {
        res.end();
      }
    }
  });
}
