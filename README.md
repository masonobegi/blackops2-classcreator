# Driftwatch

**Contract monitoring for the third-party APIs you depend on.**

Uptime monitors watch status codes. Driftwatch watches the *shape of the
response* — so when a vendor removes a field, changes a type, or quietly makes
something nullable, your customer hears it from Driftwatch instead of from their
error tracker at 2am.

It is a complete, self-contained SaaS: self-serve signup, metered plans, Stripe
subscriptions, automated polling, schema diffing, alert delivery, retention
enforcement and self-serve cancellation. **Zero runtime dependencies** — native
TypeScript, built-in SQLite, built-in `fetch` and `crypto`.

---

## Why this business

Every company integrates a dozen APIs it does not control — Stripe, Shopify,
Plaid, a partner's catalogue feed, an internal team's service. All of them ship
breaking changes without telling anyone, and the standard failure mode is
finding out from a customer.

| | |
|---|---|
| **Who pays** | Backend and platform teams who integrate vendor APIs |
| **What they buy** | Not being surprised |
| **Why it isn't saturated** | Uptime monitoring is a crowded commodity. Contract monitoring of *someone else's* API is not: the existing tools (Optic, Escape, Stoplight) are enterprise contract-testing suites for APIs *you own*, sold top-down. Nobody sells a $19/month watcher for APIs you merely consume. |
| **Why it stays cheap to run** | One HTTP request per monitor per interval, a few KB of SQLite per snapshot. A thousand monitors on a 5-minute interval is ~3 requests/second and runs on the smallest VM any host sells. |
| **Why it's genuinely hands-off** | Nothing in the loop needs a human: signup is a magic link, payment is Stripe Checkout, cancellation and card updates are the Stripe Customer Portal, downgrades enforce themselves, retention prunes itself, failed alerts retry themselves. |

### Being straight with you

This is software that can *earn* passively. It is not money that appears without
you doing anything. You still have to:

1. **Deploy it** (~20 minutes, below) and point a domain at it.
2. **Create two Stripe prices** and paste the ids into the environment.
3. **Get customers.** This is the whole job, and no code can do it for you.

Once those are done, the revenue loop genuinely runs without you: a stranger can
find the site, sign up, pay, be served, and cancel, and you will not have touched
anything. Expect to spend your time on distribution, not operations.

Where to find the first users: the "we got broken by a vendor's API change"
conversation happens constantly on Hacker News, r/webdev, r/devops, and in
language-specific Discords. Changelog pages of popular APIs are a target list.
Public post-mortems mentioning an upstream change are warm leads.

---

## How it works

```
  scheduler tick (every 10s)
        │
        ├─ claim monitors whose next_run_at has passed   (atomic UPDATE…RETURNING)
        ├─ probe each one                                (SSRF-guarded fetch)
        ├─ infer a structural schema from the JSON       (src/schema/infer.ts)
        ├─ compare against the stored baseline           (src/schema/diff.ts)
        ├─ require N consecutive identical observations  (src/monitor/evaluate.ts)
        ├─ raise an incident, classify severity
        ├─ queue a delivery per notification channel
        └─ drain the delivery queue with backoff         (src/notify/dispatch.ts)
```

The interesting part is **not** the diffing — it is the restraint. A monitoring
product that cries wolf gets muted and then cancelled, so:

- **A change must be confirmed** on consecutive checks before it alerts. One
  stale node behind a load balancer pages nobody.
- **5xx and timeouts never overwrite the baseline.** They are tracked separately
  and only alert after three consecutive failures.
- **Integers and floats are both `number`**; enum values are not tracked. A
  price that gains a decimal is not a contract change.
- **An empty array is recorded as unobserved**, not as "the element type vanished".
- **Ignore globs** (`$.meta.**`, `$.data[].updated_at`) exist for fields that
  legitimately change on every request.
- **Nullability is reported once.** `string` → `null` is one breaking change, not
  a nullability change plus a type change; and `null` → `string` is *not*
  breaking, because any consumer was already handling null.
- **A `4xx` with a JSON body is compared, not discarded.** An endpoint that
  starts answering `403` has changed its contract.
- **Editing a monitor's URL, method or body re-baselines it**, so your own edit
  cannot masquerade as the vendor breaking something.

### Severity, from the consumer's point of view

| Change | Severity |
|---|---|
| Field removed · type changed · became nullable · became optional · status code changed · content-type changed | `breaking` |
| Union widened · string format changed | `warning` |
| Field added · union narrowed · became required · array unobservable | `info` |

---

## Run it locally

Requires **Node 22.18+** (for native TypeScript execution and `node:sqlite`).

```bash
npm install          # devDependencies only — typescript and @types/node
cp .env.example .env
npm run dev          # http://localhost:8080, sign-in links shown on screen
```

`npm run dev` sets `DRIFTWATCH_DEV_LOGIN=1`, which prints the magic link to the
page instead of emailing it, and `EMAIL_PROVIDER=none` prints alert emails to
stdout. You can exercise the entire product without signing up for anything.

To watch something on your own machine, set `PROBE_ALLOW_PRIVATE_TARGETS=1`.
**Never set that on a multi-tenant deployment** — it hands every customer the
ability to probe your internal network.

```bash
npm test             # 182 tests, no network required
npm run typecheck
```

---

## Deploy it

### 1. Host it

Any host that gives you a persistent disk. SQLite in WAL mode on a mounted
volume handles this workload comfortably; you do not need Postgres, and adding it
would be the first thing to make this harder to run untended.

```bash
fly launch --no-deploy          # a fly.toml is included
fly volumes create data --size 3
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) \
                BASE_URL=https://your-domain.com \
                EMAIL_PROVIDER=resend EMAIL_API_KEY=re_... \
                EMAIL_FROM="Driftwatch <alerts@your-domain.com>"
fly deploy
```

A `Dockerfile` is included and works anywhere (Railway, Render, Hetzner + Caddy,
a Raspberry Pi). Set `DATABASE_PATH` to a path on the persistent volume.

### 2. Wire up email

Alerts and sign-in links both go through one provider. Set `EMAIL_PROVIDER` to
`resend` or `postmark` and supply `EMAIL_API_KEY`. Verify your sending domain
(SPF/DKIM) or your alerts will land in spam, which is the same as not sending
them.

### 3. Turn on the money

1. In Stripe, create a **product with two recurring monthly prices** matching
   `src/plans.ts` ($19 Pro, $79 Team — edit both if you want different numbers).
2. Add a webhook endpoint pointing at `https://your-domain.com/webhooks/stripe`,
   subscribed to:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Enable the **Customer Portal** in Stripe settings (this is what makes
   cancellations, card updates and invoices self-serve).
4. Set the secrets:

```bash
fly secrets set STRIPE_SECRET_KEY=sk_live_... \
                STRIPE_WEBHOOK_SECRET=whsec_... \
                STRIPE_PRICE_PRO=price_... \
                STRIPE_PRICE_TEAM=price_...
```

Test the loop before announcing anything:

```bash
stripe listen --forward-to localhost:8080/webhooks/stripe
stripe trigger checkout.session.completed
```

If `STRIPE_SECRET_KEY` is unset the app runs fine with everyone on the Free plan,
which is a reasonable way to launch a private beta.

### 4. Scale, when you need to

The scheduler runs in-process. To split web and worker, run two instances with
`SCHEDULER_ENABLED=0` on the web one — monitor claiming is a single atomic
`UPDATE … RETURNING`, so overlapping workers cannot double-probe. Past a few
thousand monitors, raise `SCHEDULER_CONCURRENCY` before doing anything cleverer.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that
matter:

| Variable | Notes |
|---|---|
| `BASE_URL` | Public origin. Must be `https://` in production; used for magic links and Stripe redirects. |
| `SESSION_SECRET` | Required in production. `openssl rand -hex 32`. |
| `DATABASE_PATH` | Put this on a persistent volume. |
| `EMAIL_PROVIDER` | `resend` · `postmark` · `none` (prints to stdout). |
| `STRIPE_*` | Omit to run everyone on the Free plan. |
| `TRUST_PROXY` | Default `1`. Set `0` if the process is directly exposed, so a spoofed `X-Forwarded-For` cannot reset rate limits. |
| `PROBE_ALLOW_PRIVATE_TARGETS` | Dangerous. See [SECURITY.md](SECURITY.md). |

---

## Layout

```
src/
  index.ts              entrypoint: config, db, scheduler, server, shutdown
  config.ts             environment parsing and production validation
  plans.ts              pricing and limits — the single source of truth
  db.ts                 SQLite connection and append-only migrations
  store.ts              typed data access
  schema/
    infer.ts            JSON value  -> structural schema
    diff.ts             schema pair -> classified changes
    paths.ts            ignore-glob matching
    print.ts            schema -> readable pseudo-type
  monitor/
    guard.ts            SSRF defence for customer-supplied URLs
    probe.ts            one HTTP request, capped and timed
    evaluate.ts         pure state machine: probe -> incident (the core)
    scheduler.ts        claim, check, deliver, maintain
  notify/
    render.ts           one incident -> email, Slack and webhook payloads
    transports.ts       provider calls and retryability classification
    dispatch.ts         severity routing and the delivery queue
  billing/
    stripe.ts           dependency-free Stripe client + signature verification
    webhook.ts          events -> plan changes, idempotently
    entitlements.ts     enforce plan limits without a human
  http/
    router.ts, server.ts, web.ts, api.ts, session.ts, validate.ts
  ui/                   server-rendered HTML, no client JavaScript
test/                   182 tests: unit, security, billing, full end-to-end
```

`src/monitor/evaluate.ts` is the file to read first, and the one to be careful
with: it decides what wakes a customer up at 3am.

---

## API

Pro and Team plans get a REST API. Full reference at `/docs` on a running
instance.

```bash
curl -H "Authorization: Bearer $DW_KEY" https://your-domain.com/api/v1/monitors
```

Webhook alerts are signed like Stripe's — `Driftwatch-Signature: t=…,v1=…`,
HMAC-SHA256 over `<timestamp>.<raw body>` — with verification code in `/docs`.

---

## License

MIT. It's yours — change the pricing, rename it, sell it.
