# Security notes

This service accepts URLs from strangers and fetches them from its own network.
That makes a handful of things load-bearing. If you fork this, read this file
before changing anything in `src/monitor/guard.ts`.

## Server-side request forgery (the big one)

A monitoring service is an SSRF engine by construction: customers tell it what to
fetch, and the response comes back to them. The classic attack is pointing a
monitor at `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
and reading your cloud provider's credentials out of the resulting alert.

`assertSafeUrl()` therefore enforces, **before every request and again after
every redirect**:

- `http:` and `https:` only.
- Ports restricted to 80, 443, 8080 and 8443.
- `localhost`, `*.localhost`, `*.internal` and known metadata hostnames refused
  by name.
- Every DNS answer for the host checked against reserved ranges: RFC1918,
  loopback, link-local (including `169.254.0.0/16`), carrier NAT, multicast,
  documentation and benchmarking blocks, IPv6 loopback / unique-local /
  link-local, and IPv4-mapped IPv6 forms such as `::ffff:127.0.0.1`.
- Anything that is not a parseable IP is treated as private, i.e. refused.

Redirects are followed manually (`redirect: 'manual'`, max 3) specifically so
each hop can be re-validated. A request body is not replayed across a redirect.

### Known residual risk: DNS rebinding

There is a window between the DNS check and the socket connect in which an
attacker controlling a DNS zone can return a public address to our lookup and a
private one to the connect. Closing it requires pinning the resolved IP at
connect time, which `fetch` does not expose. Mitigating factors: the attacker
needs their own DNS infrastructure, the payload they get back is a *schema*
rather than the response body, and the request is a plain GET. If you deploy this
somewhere with sensitive internal services, run it in a network segment with no
route to them — that is a better control than anything in application code.

### `PROBE_ALLOW_PRIVATE_TARGETS`

Setting this to `1` disables all of the above. It exists so a single-tenant
instance can watch internal services, and so this project's tests can target
`127.0.0.1`. **Never enable it on a deployment where accounts other than your own
can create monitors.** The startup banner warns when it is on.

## Request headers

Customers supply headers (usually an auth token). `sanitizeHeaders()`:

- drops `Host`, `Content-Length`, `Connection` and `Transfer-Encoding`, which we
  control;
- rejects header names outside the RFC 7230 token charset;
- rejects any value containing CR or LF rather than stripping it, so injection
  attempts fail loudly at save time instead of silently mangling a request;
- truncates values to 4 KB.

Customer tokens are stored in plaintext in the database, because we have to
replay them on every check. Treat the database as containing third-party
credentials: encrypt the volume, and tell customers to use read-only,
least-privilege tokens (the monitor form says so).

## Authentication

- **No passwords.** Sign-in is a single-use magic link, 20-minute expiry, stored
  as a SHA-256 hash so a database dump cannot be replayed.
- **Sessions** are 256-bit random tokens, stored hashed, in a cookie that is
  `HttpOnly`, `SameSite=Lax` and `Secure` whenever `BASE_URL` is https.
- **API keys** are `dw_live_` + 256 bits of randomness, stored hashed, with only
  a 16-character prefix kept for display. A key is shown once, at creation, and
  rendered inline rather than via a redirect so it never enters a URL, a proxy
  log or browser history.
- **CSRF**: every mutating form carries a per-session token, checked with a
  constant-time compare, on top of `SameSite=Lax`.
- **Rate limits**: 5 sign-in emails per 15 minutes per IP+address; 60 writes per
  minute per session.

Login deliberately does not reveal whether an address already has an account —
requesting a link and signing up are the same action.

## Billing

The Stripe webhook is unauthenticated by design: **the signature is the auth.**
`verifyWebhookSignature()` does a constant-time HMAC comparison with a 300-second
timestamp tolerance, and supports multiple `v1` signatures for secret rotation.
Without it, anyone who found the endpoint could grant themselves the Team plan.

Events are idempotent — the event id is claimed in a table with a primary-key
constraint, because Stripe retries for three days. A handler that throws after
claiming releases the id so the retry is useful.

Stripe is the source of truth for money; this database is the source of truth for
access. `applyEntitlements()` reconciles them on every billing event *and* hourly,
so a missed webhook during a deploy cannot leave a cancelled customer on a paid
plan indefinitely.

## Output handling

- All HTML goes through an escaping template tag; raw interpolation requires an
  explicit `raw()` call, making XSS opt-in rather than default.
- The Content-Security-Policy is `default-src 'none'` with no script source at
  all. There is no client-side JavaScript, so nothing needs relaxing.
- Response bodies from monitored APIs are **never echoed back** — only inferred
  types and field names. A monitored endpoint returning a customer's PII does not
  put that PII in an alert email.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`.

## Resource limits

- Probe responses are capped at `PROBE_MAX_BYTES` (2 MB), enforced both from
  `Content-Length` and while streaming, and the stream is cancelled on breach.
- Probe timeout is 15s; alert delivery timeout is 15s.
- Request bodies to *our* endpoints are capped at 1 MB.
- Schema inference samples at most 250 array elements and 24 levels of nesting,
  so a hostile payload cannot exhaust CPU or stack.
- Notification channel URLs are validated as https at creation. They are *not*
  SSRF-guarded at send time; the exposure is a blind POST whose response is
  discarded, which is a deliberate trade for supporting arbitrary customer
  webhook receivers.

## Reporting

Open an issue, or for anything exploitable, contact the maintainer privately
before disclosing.
