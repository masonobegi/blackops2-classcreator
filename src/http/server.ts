import { createServer as createHttpServer, type Server } from 'node:http';
import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import type { Scheduler } from '../monitor/scheduler.ts';
import { registerApiRoutes } from './api.ts';
import { registerWebRoutes } from './web.ts';
import { buildContext, createRouter, send, textReply } from './router.ts';

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
      const ctx = buildContext(req, deps.config.baseUrl, params);
      const reply = await handler(ctx);
      send(res, reply, method === 'HEAD');

      if (reply.status >= 400 || path.startsWith('/api/') || path.startsWith('/webhooks/')) {
        console.log(
          `${method} ${path} ${reply.status} ${Math.round(performance.now() - started)}ms`,
        );
      }
    } catch (error) {
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
