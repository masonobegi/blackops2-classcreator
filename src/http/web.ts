import type { Config } from '../config.ts';
import type { Database } from '../db.ts';
import { applyEntitlements, canAddMonitor } from '../billing/entitlements.ts';
import { createCheckoutSession, createCustomer, createPortalSession } from '../billing/stripe.ts';
import { syncCustomerSubscription } from '../billing/webhook.ts';
import { parseJson } from '../lib/util.ts';
import { createRateLimiter } from '../lib/ratelimit.ts';
import { sendLoginEmail } from '../notify/dispatch.ts';
import type { Scheduler } from '../monitor/scheduler.ts';
import { effectivePlan } from '../plans.ts';
import {
  acknowledgeIncident,
  consumeLoginToken,
  createApiKey,
  createChannel,
  createLoginToken,
  createMonitor,
  createSession,
  deleteApiKey,
  deleteChannel,
  deleteMonitor,
  deleteSession,
  getIncident,
  getUserMonitor,
  listApiKeys,
  listChannels,
  listIncidentsForMonitor,
  listIncidentsForUser,
  listMonitors,
  listSnapshots,
  resetBaseline,
  setAlertMinSeverity,
  setMonitorStatus,
  setUserBilling,
  updateMonitorSettings,
  upsertUser,
} from '../store.ts';
import {
  billingPage,
  dashboardPage,
  incidentDetailPage,
  incidentsPage,
  monitorDetailPage,
  monitorFormPage,
  settingsPage,
} from '../ui/app.ts';
import { docsPage, errorPage, landingPage, loginPage } from '../ui/marketing.ts';
import { page } from '../ui/layout.ts';
import { html } from '../lib/html.ts';
import {
  htmlReply,
  redirect,
  textReply,
  withCookie,
  type Handler,
  type Reply,
  type RequestContext,
  type Router,
} from './router.ts';
import {
  checkCsrf,
  clearSessionCookie,
  currentAuth,
  sessionCookie,
  SESSION_COOKIE,
  type Auth,
} from './session.ts';
import { parseSeverity, validateChannel, validateMonitor } from './validate.ts';

export type WebDeps = {
  db: Database;
  config: Config;
  scheduler: Scheduler;
};

// Login emails cost money and land in someone's inbox, so they get a tight cap.
const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
const writeLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

export function registerWebRoutes(router: Router, deps: WebDeps): void {
  const { db, config, scheduler } = deps;

  const planFor = (auth: Auth) => effectivePlan(auth.user.plan, auth.user.subscription_status);
  const flashOf = (ctx: RequestContext) => ctx.url.searchParams.get('status');

  /** Wrap a page that requires a signed-in user. */
  const authed =
    (handler: (ctx: RequestContext, auth: Auth) => Promise<Reply> | Reply): Handler =>
    async (ctx) => {
      const auth = currentAuth(db, ctx);
      if (!auth) return redirect(`/login?next=${encodeURIComponent(ctx.path)}`);
      return handler(ctx, auth);
    };

  /** Wrap a mutating form post: requires a session and a valid CSRF token. */
  const authedPost =
    (
      handler: (
        ctx: RequestContext,
        auth: Auth,
        form: URLSearchParams,
      ) => Promise<Reply> | Reply,
    ): Handler =>
    async (ctx) => {
      const auth = currentAuth(db, ctx);
      if (!auth) return redirect('/login');

      const limit = writeLimiter.check(auth.user.id);
      if (!limit.allowed) {
        return htmlReply(
          errorPage(429, `Too many requests. Try again in ${limit.retryAfterSeconds}s.`, auth.user),
          429,
        );
      }

      const form = await ctx.form();
      if (!checkCsrf(auth, form)) {
        return htmlReply(
          errorPage(403, 'That form was stale or came from another site. Please try again.', auth.user),
          403,
        );
      }
      return handler(ctx, auth, form);
    };

  // ------------------------------------------------------------ marketing ---

  router.get('/', (ctx) => {
    const auth = currentAuth(db, ctx);
    if (auth) return redirect('/dashboard');
    return htmlReply(landingPage(flashOf(ctx)));
  });

  router.get('/docs', (ctx) => {
    const auth = currentAuth(db, ctx);
    return htmlReply(docsPage(auth?.user ?? null, config.baseUrl));
  });

  router.get('/robots.txt', () =>
    textReply(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /api/\nSitemap: ${config.baseUrl}/sitemap.xml\n`),
  );

  router.get('/sitemap.xml', () => ({
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${config.baseUrl}/</loc><priority>1.0</priority></url>
  <url><loc>${config.baseUrl}/docs</loc><priority>0.7</priority></url>
  <url><loc>${config.baseUrl}/login</loc><priority>0.5</priority></url>
</urlset>`,
  }));

  router.get('/status', (ctx) => {
    const auth = currentAuth(db, ctx);
    const row = db
      .prepare(
        `select
           (select count(*) from monitors where status = 'active') as active,
           (select count(*) from snapshots where created_at > ?) as checks_1h,
           (select count(*) from deliveries where status = 'pending') as queued`,
      )
      .get(Date.now() - 3_600_000) as { active: number; checks_1h: number; queued: number };

    return htmlReply(
      page(
        { title: 'Status — Driftwatch', user: auth?.user ?? null, narrow: true },
        html`
          <h1>Status</h1>
          <p class="sub">Live counters from this instance.</p>
          <div class="grid c3">
            <div class="stat"><div class="k">Active monitors</div><div class="v">${row.active}</div></div>
            <div class="stat"><div class="k">Checks last hour</div><div class="v">${row.checks_1h}</div></div>
            <div class="stat"><div class="k">Alerts queued</div><div class="v">${row.queued}</div></div>
          </div>
          <p style="margin-top:24px">
            Scheduler is ${config.scheduler.enabled ? 'running' : 'disabled'} on this node.
          </p>
        `,
      ),
    );
  });

  // ----------------------------------------------------------------- auth ---

  router.get('/login', (ctx) => {
    const auth = currentAuth(db, ctx);
    if (auth) return redirect('/dashboard');
    const status = flashOf(ctx);
    const error = status === 'expired' ? 'That sign-in link has expired or was already used.' : null;
    return htmlReply(loginPage(false, '', null, error));
  });

  router.post('/login', async (ctx) => {
    const form = await ctx.form();
    const email = (form.get('email') ?? '').trim().toLowerCase();

    if (!/^[^\s@]{1,64}@[^\s@.]+\.[^\s@]{2,}$/.test(email)) {
      return htmlReply(loginPage(false, email, null, 'That email address does not look right.'), 400);
    }

    const limit = loginLimiter.check(`${ctx.ip}:${email}`);
    if (!limit.allowed) {
      return htmlReply(
        loginPage(
          false,
          email,
          null,
          `Too many sign-in attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
        ),
        429,
      );
    }

    // Sign-up and sign-in are the same action. This is the entire funnel.
    const user = upsertUser(db, email);
    const token = createLoginToken(db, user.id);
    const url = `${config.baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;

    const result = await sendLoginEmail(config, email, url);
    if (!result.ok) console.error(`[auth] login email to ${email} failed: ${result.error}`);

    // Showing the link on screen is a development affordance only.
    return htmlReply(loginPage(true, email, config.devLogin ? url : null, null));
  });

  router.get('/auth/verify', (ctx) => {
    const token = ctx.url.searchParams.get('token');
    if (!token) return redirect('/login?status=expired');

    const user = consumeLoginToken(db, token);
    if (!user) return redirect('/login?status=expired');

    const { token: sessionToken } = createSession(db, user.id);
    return withCookie(redirect('/dashboard'), sessionCookie(config, sessionToken));
  });

  router.post('/logout', async (ctx) => {
    const token = ctx.cookies[SESSION_COOKIE];
    const auth = currentAuth(db, ctx);
    const form = await ctx.form();
    if (auth && !checkCsrf(auth, form)) return redirect('/settings');
    if (token) deleteSession(db, token);
    return withCookie(redirect('/'), clearSessionCookie(config));
  });

  // ------------------------------------------------------------ dashboard ---

  router.get(
    '/dashboard',
    authed((ctx, auth) => {
      const monitors = listMonitors(db, auth.user.id);
      const incidents = listIncidentsForUser(db, auth.user.id, 50).filter(
        (incident) => incident.created_at > Date.now() - 30 * 86_400_000,
      );
      return htmlReply(dashboardPage(auth.user, planFor(auth), monitors, incidents, flashOf(ctx)));
    }),
  );

  // --------------------------------------------------------------- monitors -

  router.get(
    '/monitors/new',
    authed((ctx, auth) => {
      const { allowed } = canAddMonitor(db, auth.user.id);
      if (!allowed) return redirect('/dashboard?status=limit-reached');
      return htmlReply(monitorFormPage(auth.user, auth.csrf, planFor(auth), null, flashOf(ctx)));
    }),
  );

  router.post(
    '/monitors',
    authedPost((_ctx, auth, form) => {
      const { allowed, plan } = canAddMonitor(db, auth.user.id);
      if (!allowed) return redirect('/dashboard?status=limit-reached');

      const validation = validateMonitor(
        {
          name: form.get('name'),
          method: form.get('method'),
          url: form.get('url'),
          headers: form.get('headers'),
          body: form.get('body'),
          intervalSeconds: form.get('interval_seconds'),
          ignorePaths: form.get('ignore_paths'),
          minSeverity: form.get('min_severity'),
          confirmations: form.get('confirmations'),
        },
        plan,
      );
      if (!validation.ok) return redirect('/monitors/new?status=invalid-input');

      const monitor = createMonitor(db, { userId: auth.user.id, ...validation.value });
      return redirect(`/monitors/${monitor.id}?status=created`);
    }),
  );

  router.get(
    '/monitors/:id',
    authed((ctx, auth) => {
      const monitor = getUserMonitor(db, auth.user.id, ctx.params.id ?? '');
      if (!monitor) return htmlReply(errorPage(404, 'No such monitor.', auth.user), 404);
      return htmlReply(
        monitorDetailPage(
          auth.user,
          auth.csrf,
          monitor,
          listIncidentsForMonitor(db, monitor.id, 25),
          listSnapshots(db, monitor.id, 40),
          flashOf(ctx),
        ),
      );
    }),
  );

  router.get(
    '/monitors/:id/edit',
    authed((ctx, auth) => {
      const monitor = getUserMonitor(db, auth.user.id, ctx.params.id ?? '');
      if (!monitor) return htmlReply(errorPage(404, 'No such monitor.', auth.user), 404);
      return htmlReply(monitorFormPage(auth.user, auth.csrf, planFor(auth), monitor, flashOf(ctx)));
    }),
  );

  router.post(
    '/monitors/:id',
    authedPost((ctx, auth, form) => {
      const id = ctx.params.id ?? '';
      const monitor = getUserMonitor(db, auth.user.id, id);
      if (!monitor) return htmlReply(errorPage(404, 'No such monitor.', auth.user), 404);

      const validation = validateMonitor(
        {
          name: form.get('name'),
          method: form.get('method'),
          url: form.get('url'),
          headers: form.get('headers'),
          body: form.get('body'),
          intervalSeconds: form.get('interval_seconds'),
          ignorePaths: form.get('ignore_paths'),
          minSeverity: form.get('min_severity'),
          confirmations: form.get('confirmations'),
        },
        planFor(auth),
      );
      if (!validation.ok) return redirect(`/monitors/${id}/edit?status=invalid-input`);

      updateMonitorSettings(db, auth.user.id, id, validation.value);

      // Changing the request means the old baseline describes a different thing.
      if (validation.value.url !== monitor.url || validation.value.method !== monitor.method) {
        resetBaseline(db, auth.user.id, id);
      }
      return redirect(`/monitors/${id}?status=updated`);
    }),
  );

  router.post(
    '/monitors/:id/delete',
    authedPost((ctx, auth) => {
      deleteMonitor(db, auth.user.id, ctx.params.id ?? '');
      return redirect('/dashboard?status=deleted');
    }),
  );

  router.post(
    '/monitors/:id/toggle',
    authedPost((ctx, auth) => {
      const id = ctx.params.id ?? '';
      const monitor = getUserMonitor(db, auth.user.id, id);
      if (!monitor) return redirect('/dashboard');

      if (monitor.status === 'active') {
        setMonitorStatus(db, id, 'paused', 'Paused by you');
        return redirect(`/monitors/${id}?status=paused`);
      }
      const { allowed } = canAddMonitor(db, auth.user.id);
      if (!allowed && monitor.pause_reason === 'Plan limit reached') {
        return redirect(`/monitors/${id}?status=limit-reached`);
      }
      setMonitorStatus(db, id, 'active', null);
      return redirect(`/monitors/${id}?status=resumed`);
    }),
  );

  router.post(
    '/monitors/:id/reset',
    authedPost((ctx, auth) => {
      const id = ctx.params.id ?? '';
      if (!getUserMonitor(db, auth.user.id, id)) return redirect('/dashboard');
      resetBaseline(db, auth.user.id, id);
      return redirect(`/monitors/${id}?status=reset`);
    }),
  );

  router.post(
    '/monitors/:id/check',
    authedPost(async (ctx, auth) => {
      const id = ctx.params.id ?? '';
      if (!getUserMonitor(db, auth.user.id, id)) return redirect('/dashboard');
      await scheduler.runMonitorNow(id);
      return redirect(`/monitors/${id}`);
    }),
  );

  router.post(
    '/monitors/:id/ignore',
    authedPost((ctx, auth, form) => {
      const id = ctx.params.id ?? '';
      const monitor = getUserMonitor(db, auth.user.id, id);
      if (!monitor) return redirect('/dashboard');

      const existing = parseJson<string[]>(monitor.ignore_paths_json, []);
      const added = (form.get('paths') ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      const merged = [...new Set([...existing, ...added])].slice(0, 100);

      updateMonitorSettings(db, auth.user.id, id, { ignorePaths: merged });
      return redirect(`/monitors/${id}?status=updated`);
    }),
  );

  // -------------------------------------------------------------- incidents -

  router.get(
    '/incidents',
    authed((ctx, auth) =>
      htmlReply(
        incidentsPage(
          auth.user,
          listIncidentsForUser(db, auth.user.id, 100),
          listMonitors(db, auth.user.id),
          flashOf(ctx),
        ),
      ),
    ),
  );

  router.get(
    '/incidents/:id',
    authed((ctx, auth) => {
      const incident = getIncident(db, auth.user.id, ctx.params.id ?? '');
      if (!incident) return htmlReply(errorPage(404, 'No such incident.', auth.user), 404);
      const monitor = getUserMonitor(db, auth.user.id, incident.monitor_id);
      if (!monitor) return htmlReply(errorPage(404, 'That monitor is gone.', auth.user), 404);
      return htmlReply(
        incidentDetailPage(auth.user, auth.csrf, incident, monitor, flashOf(ctx)),
      );
    }),
  );

  router.post(
    '/incidents/:id/ack',
    authedPost((ctx, auth) => {
      const id = ctx.params.id ?? '';
      acknowledgeIncident(db, auth.user.id, id);
      return redirect(`/incidents/${id}?status=acknowledged`);
    }),
  );

  // --------------------------------------------------------------- settings -

  const renderSettings = (auth: Auth, newKey: string | null, status: string | null): Reply =>
    htmlReply(
      settingsPage(
        auth.user,
        auth.csrf,
        planFor(auth),
        listChannels(db, auth.user.id),
        listApiKeys(db, auth.user.id),
        newKey,
        status,
      ),
    );

  router.get(
    '/settings',
    authed((ctx, auth) => renderSettings(auth, null, flashOf(ctx))),
  );

  router.post(
    '/settings/severity',
    authedPost((_ctx, auth, form) => {
      const severity = parseSeverity(form.get('alert_min_severity'));
      if (severity) setAlertMinSeverity(db, auth.user.id, severity);
      return redirect('/settings?status=updated');
    }),
  );

  router.post(
    '/settings/channels',
    authedPost((_ctx, auth, form) => {
      const plan = planFor(auth);
      if (listChannels(db, auth.user.id).length >= plan.channels) {
        return redirect('/settings?status=plan-required');
      }
      const validation = validateChannel(form.get('kind'), form.get('target'));
      if (!validation.ok) return redirect('/settings?status=invalid-input');

      createChannel(db, auth.user.id, validation.value.kind, validation.value.target);
      return redirect('/settings?status=channel-added');
    }),
  );

  router.post(
    '/settings/channels/:id/delete',
    authedPost((ctx, auth) => {
      deleteChannel(db, auth.user.id, ctx.params.id ?? '');
      return redirect('/settings?status=channel-removed');
    }),
  );

  router.post(
    '/settings/keys',
    authedPost((_ctx, auth, form) => {
      if (!planFor(auth).apiAccess) return redirect('/settings?status=plan-required');
      const { token } = createApiKey(db, auth.user.id, (form.get('label') ?? '').trim().slice(0, 60));
      // Rendered inline rather than redirected: the plaintext key must never
      // end up in a URL, a proxy log or the browser's history.
      return renderSettings(auth, token, null);
    }),
  );

  router.post(
    '/settings/keys/:id/delete',
    authedPost((ctx, auth) => {
      deleteApiKey(db, auth.user.id, ctx.params.id ?? '');
      return redirect('/settings?status=key-deleted');
    }),
  );

  // ---------------------------------------------------------------- billing -

  router.get(
    '/billing',
    authed((ctx, auth) =>
      htmlReply(
        billingPage(auth.user, auth.csrf, planFor(auth), config.stripe.enabled, flashOf(ctx)),
      ),
    ),
  );

  router.post(
    '/billing/checkout',
    authedPost(async (_ctx, auth, form) => {
      if (!config.stripe.enabled) return redirect('/billing?status=billing-unavailable');

      const requested = form.get('plan');
      if (requested !== 'pro' && requested !== 'team') {
        return redirect('/billing?status=invalid-input');
      }
      const priceId = config.stripe.prices[requested];
      if (!priceId) return redirect('/billing?status=billing-unavailable');

      try {
        let customerId = auth.user.stripe_customer_id;
        if (!customerId) {
          const customer = await createCustomer(config, auth.user.email, auth.user.id);
          customerId = customer.id;
          setUserBilling(db, auth.user.id, { stripeCustomerId: customerId });
        }

        const session = await createCheckoutSession(config, {
          customerId,
          priceId,
          userId: auth.user.id,
          planId: requested,
        });
        return redirect(session.url);
      } catch (error) {
        console.error('[billing] checkout failed:', error);
        return redirect('/billing?status=billing-unavailable');
      }
    }),
  );

  router.post(
    '/billing/portal',
    authedPost(async (_ctx, auth) => {
      if (!config.stripe.enabled || !auth.user.stripe_customer_id) {
        return redirect('/billing?status=billing-unavailable');
      }
      try {
        const session = await createPortalSession(config, auth.user.stripe_customer_id);
        return redirect(session.url);
      } catch (error) {
        console.error('[billing] portal failed:', error);
        return redirect('/billing?status=billing-unavailable');
      }
    }),
  );

  router.get(
    '/billing/return',
    authed(async (_ctx, auth) => {
      // The webhook is authoritative, but it may not have landed yet — and if
      // webhooks are misconfigured it may never. Pull the subscription directly
      // so a paying customer is never left looking at the Free plan.
      if (config.stripe.enabled && auth.user.stripe_customer_id) {
        try {
          await syncCustomerSubscription(db, config, auth.user.id);
        } catch (error) {
          console.error('[billing] post-checkout sync failed:', error);
        }
      }
      applyEntitlements(db, auth.user.id);
      return redirect('/billing?status=success');
    }),
  );

  // ------------------------------------------------------------------- 404 --

  router.setFallback((ctx) => {
    const auth = currentAuth(db, ctx);
    if (ctx.path.startsWith('/api/')) {
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { type: 'not_found', message: 'No such endpoint' } }),
      };
    }
    return htmlReply(errorPage(404, 'That page does not exist.', auth?.user ?? null), 404);
  });
}
