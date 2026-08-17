import { html, type Raw } from '../lib/html.ts';
import { PLAN_ORDER, PLANS, type PlanId } from '../plans.ts';
import type { UserRow } from '../store.ts';
import { flash, page } from './layout.ts';

const SAMPLE_DIFF = `- "customer_id":  string
+ "customer_id":  string | null      BREAKING  can now be null
- "legacy_total": number
                                     BREAKING  field was removed
+ "totals": { "gross": number, ... } INFO      field was added`;

export function landingPage(status: string | null): Raw {
  return page(
    {
      title: 'Driftwatch — know before your vendor’s API breaks you',
      description:
        'Driftwatch polls the third-party APIs you depend on, learns their response shape, and alerts you the moment a field is removed, retyped or made nullable.',
    },
    html`
      ${flash(status)}
      <section class="hero">
        <h1>Your vendor changed their API. You found out from a customer.</h1>
        <p class="lead">
          Uptime monitors watch status codes. Driftwatch watches the
          <span class="mark">shape of the response</span> — so when a field is removed,
          retyped or quietly becomes <code>null</code>, you hear it from us instead of
          from your error tracker at 2am.
        </p>
        <div class="actions" style="margin:26px 0 8px">
          <a class="btn" href="/login">Start monitoring free</a>
          <a class="btn secondary" href="#how">How it works</a>
        </div>
        <p style="font-size:13px">Two monitors free forever. No card, no sales call.</p>
      </section>

      <section style="margin-top:44px">
        <div class="card">
          <h3>What an alert looks like</h3>
          <pre class="code">${SAMPLE_DIFF}</pre>
          <p style="margin:0">
            Every change is classified from your point of view: <strong>breaking</strong> if
            it can make your deserialiser throw or read <code>undefined</code>,
            <strong>info</strong> if you can safely ignore it.
          </p>
        </div>
      </section>

      <section id="how">
        <h2>How it works</h2>
        <div class="grid c3">
          <div class="card">
            <h3>1. Point it at an endpoint</h3>
            <p style="margin:0">
              A URL, a method, and any auth headers you need. Nothing to install, no
              SDK, no proxy in your request path.
            </p>
          </div>
          <div class="card">
            <h3>2. It learns the contract</h3>
            <p style="margin:0">
              The first response becomes a baseline: field names, types, nullability,
              which fields are always present, string formats, array element shapes.
            </p>
          </div>
          <div class="card">
            <h3>3. You get told what moved</h3>
            <p style="margin:0">
              Every change arrives as a diff with a severity, by email, Slack or a
              signed webhook — after being confirmed twice, so flaky responses stay quiet.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2>Built to not cry wolf</h2>
        <div class="grid c2">
          <div class="card">
            <h3>Confirmation before notification</h3>
            <p style="margin:0">
              A change must be observed on consecutive checks before it becomes an
              alert. One stale node behind a load balancer will not page you.
            </p>
          </div>
          <div class="card">
            <h3>Ignore rules for noisy fields</h3>
            <p style="margin:0">
              <code>$.meta.request_id</code>, <code>$.**.server_time</code> — glob out the
              fields that legitimately change on every request.
            </p>
          </div>
          <div class="card">
            <h3>5xx is not a contract change</h3>
            <p style="margin:0">
              Server errors and timeouts never overwrite your baseline. They are tracked
              separately, and only alert after three consecutive failures.
            </p>
          </div>
          <div class="card">
            <h3>Status and content type count too</h3>
            <p style="margin:0">
              A <code>200 application/json</code> that becomes <code>403</code> is a
              breaking change, and it is treated as one.
            </p>
          </div>
        </div>
      </section>

      ${pricingSection(null)}

      <section>
        <h2>Questions people actually ask</h2>
        <div class="card">
          <h3>Does this sit in my request path?</h3>
          <p>
            No. Driftwatch calls the upstream API itself on a schedule. If it goes down,
            nothing of yours is affected.
          </p>
          <h3>What about authenticated endpoints?</h3>
          <p>
            Add the headers you would normally send. Prefer a read-only, least-privilege
            token — and point monitors at sandbox endpoints where the vendor offers one.
          </p>
          <h3>Can I watch my own API instead?</h3>
          <p>
            Plenty of customers do, as a public-contract regression check: it catches the
            accidental breaking change that shipped without a version bump.
          </p>
          <h3>Will it hammer the API I'm watching?</h3>
          <p style="margin:0">
            One request per monitor per interval. On the Free plan that is 24 requests a day.
          </p>
        </div>
      </section>
    `,
  );
}

export function pricingSection(currentPlan: PlanId | null): Raw {
  return html`
    <section id="pricing">
      <h2>Pricing</h2>
      <p class="sub">Monthly, cancel any time from the billing portal.</p>
      <div class="grid c3">
        ${PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const isCurrent = currentPlan === id;
          return html`
            <div class="card plan ${isCurrent ? 'current' : ''}">
              <h3>${plan.name} ${isCurrent ? html`<span class="badge ok">current</span>` : ''}</h3>
              <div class="price">
                <span class="amt">$${plan.priceUsd}</span><span class="per">/month</span>
              </div>
              <p style="font-size:13.5px;min-height:40px">${plan.blurb}</p>
              <ul class="ticks">
                ${plan.features.map((feature) => html`<li>${feature}</li>`)}
              </ul>
              ${planAction(id, currentPlan)}
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function planAction(id: PlanId, currentPlan: PlanId | null): Raw {
  if (currentPlan === null) {
    return html`<a class="btn ${id === 'pro' ? '' : 'secondary'}" href="/login">Get started</a>`;
  }
  if (currentPlan === id) {
    return html`<a class="btn secondary" href="/billing">Manage</a>`;
  }
  if (id === 'free') {
    return html`<a class="btn secondary" href="/billing">Downgrade in portal</a>`;
  }
  return html`
    <form method="post" action="/billing/checkout">
      <input type="hidden" name="plan" value="${id}">
      <button class="btn ${id === 'pro' ? '' : 'secondary'}" type="submit">
        Switch to ${PLANS[id].name}
      </button>
    </form>
  `;
}

export function loginPage(sent: boolean, email: string, devLink: string | null, error: string | null): Raw {
  return page(
    { title: 'Sign in — Driftwatch', narrow: true },
    sent
      ? html`
          <h1>Check your email</h1>
          <p class="sub">
            We sent a sign-in link to <strong>${email}</strong>. It works once and expires
            in 20 minutes.
          </p>
          ${devLink
            ? html`
                <div class="notice warn">
                  Development mode: <a href="${devLink}">click here to sign in</a>.
                </div>
              `
            : ''}
          <p><a href="/login">Use a different address</a></p>
        `
      : html`
          <h1>Sign in</h1>
          <p class="sub">
            No password. Enter your email and we'll send a link. New addresses get an
            account automatically.
          </p>
          ${error ? html`<div class="notice err">${error}</div>` : ''}
          <form method="post" action="/login" class="card">
            <div class="field">
              <label for="email">Email address</label>
              <input id="email" name="email" type="email" required autofocus
                     autocomplete="email" placeholder="you@company.com" value="${email}">
            </div>
            <button class="btn" type="submit">Send sign-in link</button>
          </form>
        `,
  );
}

export function docsPage(user: UserRow | null, baseUrl: string): Raw {
  return page(
    { title: 'Docs — Driftwatch', user, active: 'docs' },
    html`
      <h1>Docs</h1>
      <p class="sub">Everything here works without opening a support ticket.</p>

      <h2>Severity model</h2>
      <p>Changes are classified from the perspective of a consumer of the API — you.</p>
      <div class="scroll">
        <table>
          <thead><tr><th>Change</th><th>Severity</th><th>Why</th></tr></thead>
          <tbody>
            <tr><td class="path">field removed</td><td><span class="badge breaking">BREAKING</span></td><td>Your code reads <code>undefined</code>.</td></tr>
            <tr><td class="path">type changed</td><td><span class="badge breaking">BREAKING</span></td><td><code>string</code> → <code>number</code> breaks parsing.</td></tr>
            <tr><td class="path">became nullable</td><td><span class="badge breaking">BREAKING</span></td><td>The most common silent production break.</td></tr>
            <tr><td class="path">no longer always present</td><td><span class="badge breaking">BREAKING</span></td><td>A required field became optional.</td></tr>
            <tr><td class="path">HTTP status changed</td><td><span class="badge breaking">BREAKING</span></td><td>e.g. <code>200</code> → <code>403</code>.</td></tr>
            <tr><td class="path">type widened</td><td><span class="badge warning">WARNING</span></td><td>A new variant appeared in a union.</td></tr>
            <tr><td class="path">string format changed</td><td><span class="badge warning">WARNING</span></td><td>e.g. <code>datetime</code> → unformatted.</td></tr>
            <tr><td class="path">field added</td><td><span class="badge info">INFO</span></td><td>Additive; safe to ignore.</td></tr>
            <tr><td class="path">type narrowed</td><td><span class="badge info">INFO</span></td><td>Fewer variants than before.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Ignore path syntax</h2>
      <p>One pattern per line on the monitor form. <code>*</code> matches one segment, <code>**</code> matches any number.</p>
      <pre class="code">$.meta.request_id        # one exact field
$.data[].updated_at      # a field on every array element
$.**.server_time         # that field at any depth
$.debug.**               # the whole subtree
$.headers.*              # every direct child</pre>

      <h2>Webhook payloads</h2>
      <p>Webhook channels receive a POST with this body:</p>
      <pre class="code">{
  "type": "incident.schema",
  "incident": {
    "id": "inc_...",
    "severity": "breaking",
    "kind": "schema",
    "summary": "Breaking: $.data[].customer_id can now be null",
    "created_at": "2026-01-09T11:22:33.000Z",
    "url": "${baseUrl}/incidents/inc_...",
    "from_schema": "6f1c...", "to_schema": "9ab2..."
  },
  "monitor": { "id": "mon_...", "name": "Vendor billing", "method": "GET", "url": "https://..." },
  "changes": [
    { "path": "$.data[].customer_id", "kind": "became_nullable",
      "severity": "breaking", "from": "string", "to": "string | null",
      "message": "$.data[].customer_id can now be null" }
  ]
}</pre>

      <h3>Verifying the signature</h3>
      <p>
        Each request carries <code>Driftwatch-Signature: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>,
        where the HMAC is SHA-256 over <code>&lt;t&gt;.&lt;raw body&gt;</code> keyed with your
        channel secret.
      </p>
      <pre class="code">import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2)));
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1 ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}</pre>

      <h2>REST API</h2>
      <p>
        Available on Pro and Team. Create a key under
        <a href="/settings">Settings</a> and send it as
        <code>Authorization: Bearer dw_live_…</code>.
      </p>
      <pre class="code"># List monitors
curl -H "Authorization: Bearer $DW_KEY" ${baseUrl}/api/v1/monitors

# Create one
curl -X POST ${baseUrl}/api/v1/monitors \\
  -H "Authorization: Bearer $DW_KEY" -H 'content-type: application/json' \\
  -d '{
        "name": "Vendor billing",
        "url": "https://api.vendor.com/v2/invoices",
        "method": "GET",
        "interval_seconds": 300,
        "headers": { "authorization": "Bearer ..." },
        "ignore_paths": ["$.meta.request_id"]
      }'

# Recent incidents
curl -H "Authorization: Bearer $DW_KEY" "${baseUrl}/api/v1/incidents?limit=20"

# Delete a monitor
curl -X DELETE -H "Authorization: Bearer $DW_KEY" ${baseUrl}/api/v1/monitors/mon_...</pre>

      <h2>Limits and behaviour</h2>
      <ul class="ticks">
        <li>Responses are read up to 2 MB; larger ones are recorded as a failed check.</li>
        <li>Up to 3 redirects are followed, and every hop is re-validated.</li>
        <li>Only public http(s) endpoints on ports 80, 443, 8080 and 8443 can be monitored.</li>
        <li>Arrays are sampled to their first 250 elements when inferring element shape.</li>
        <li>Integers and floats are both <code>number</code>; enum values are not tracked.</li>
      </ul>
    `,
  );
}

export function errorPage(status: number, message: string, user: UserRow | null): Raw {
  return page(
    { title: `${status} — Driftwatch`, user, narrow: true },
    html`
      <h1>${status}</h1>
      <p class="sub">${message}</p>
      <a class="btn secondary" href="${user ? '/dashboard' : '/'}">Go back</a>
    `,
  );
}
