import { html, raw, type Raw } from '../lib/html.ts';
import type { UserRow } from '../store.ts';

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#0d0f13; --panel:#14171c; --panel-2:#191d23; --line:#242832;
  --text:#e9ebef; --muted:#9aa1ad; --dim:#6b7280;
  --accent:#5b83ff;
  --breaking:#ff6b6b; --warning:#ffa94d; --info:#4dabf7; --ok:#51cf66;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code,pre,.mono{font-family:var(--mono)}
hr{border:0;border-top:1px solid var(--line);margin:32px 0}

.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.wrap.narrow{max-width:620px}
.wrap.prose{max-width:760px}

header.top{border-bottom:1px solid var(--line);background:rgba(13,15,19,.85)}
header.top .row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}
.brand{display:flex;align-items:center;gap:9px;font:700 16px/1 var(--sans);color:var(--text)}
.brand:hover{text-decoration:none}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
nav.links{display:flex;align-items:center;gap:20px;font-size:14px}
nav.links a{color:var(--muted)}
nav.links a.active{color:var(--text)}

main{padding:36px 0 72px}
h1{font:700 30px/1.25 var(--sans);margin:0 0 8px;letter-spacing:-.02em}
h2{font:650 20px/1.3 var(--sans);margin:36px 0 12px;letter-spacing:-.01em}
h3{font:600 15px/1.4 var(--sans);margin:24px 0 8px}
p{margin:0 0 14px;color:var(--muted)}
p.lead{font-size:17px;color:var(--muted);max-width:60ch}
.sub{color:var(--muted);font-size:14px;margin:0 0 24px}

.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
.card+.card{margin-top:16px}
.card h3{margin-top:0}
.grid{display:grid;gap:16px}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid.c3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}

.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat .k{font:11px/1 var(--sans);letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
.stat .v{margin-top:7px;font:650 24px/1 var(--sans);color:var(--text)}
.stat .v small{font-size:13px;font-weight:400;color:var(--muted)}

table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 11px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding:0 12px 10px}
td{padding:11px 12px;border-top:1px solid var(--line);vertical-align:top}
tr.clickable:hover td{background:var(--panel-2)}
.scroll{overflow-x:auto}

.badge{display:inline-block;padding:3px 8px;border-radius:5px;font:600 11px/1.4 var(--mono);letter-spacing:.04em;white-space:nowrap}
.badge.breaking{background:rgba(255,107,107,.14);color:var(--breaking)}
.badge.warning{background:rgba(255,169,77,.14);color:var(--warning)}
.badge.info{background:rgba(77,171,247,.14);color:var(--info)}
.badge.ok{background:rgba(81,207,102,.14);color:var(--ok)}
.badge.muted{background:rgba(154,161,173,.12);color:var(--muted)}

.btn{display:inline-block;padding:9px 16px;border-radius:8px;border:1px solid transparent;
  background:var(--accent);color:#fff;font:600 14px/1.2 var(--sans);cursor:pointer;text-decoration:none}
.btn:hover{filter:brightness(1.08);text-decoration:none}
.btn.secondary{background:var(--panel-2);border-color:var(--line);color:var(--text)}
.btn.danger{background:transparent;border-color:rgba(255,107,107,.4);color:var(--breaking)}
.btn.small{padding:6px 11px;font-size:13px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}

label{display:block;font:600 13px/1.4 var(--sans);color:var(--text);margin:0 0 6px}
label .hint{display:block;font-weight:400;color:var(--dim);font-size:12px;margin-top:3px}
input[type=text],input[type=email],input[type=url],input[type=number],select,textarea{
  width:100%;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
  background:#0f1216;color:var(--text);font:14px/1.5 var(--sans)}
textarea{font-family:var(--mono);font-size:13px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
.field{margin-bottom:18px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px}

.notice{padding:11px 14px;border-radius:9px;font-size:14px;margin-bottom:20px;border:1px solid}
.notice.ok{background:rgba(81,207,102,.08);border-color:rgba(81,207,102,.3);color:#a9e5b6}
.notice.err{background:rgba(255,107,107,.08);border-color:rgba(255,107,107,.3);color:#ffb3b3}
.notice.warn{background:rgba(255,169,77,.08);border-color:rgba(255,169,77,.3);color:#ffd7a8}

pre.code{background:#0b0d11;border:1px solid var(--line);border-radius:9px;padding:14px 16px;
  overflow-x:auto;font-size:13px;line-height:1.6;color:#cfd4dd;margin:0 0 16px}
.path{font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-all}
.url{font-family:var(--mono);font-size:12.5px;color:var(--dim);word-break:break-all}
.empty{padding:40px 20px;text-align:center;color:var(--dim);border:1px dashed var(--line);border-radius:11px}

.price{display:flex;align-items:baseline;gap:5px;margin:6px 0 14px}
.price .amt{font:700 34px/1 var(--sans);letter-spacing:-.02em;color:var(--text)}
.price .per{color:var(--dim);font-size:14px}
ul.ticks{list-style:none;padding:0;margin:0 0 20px;font-size:14px;color:var(--muted)}
ul.ticks li{padding:5px 0 5px 22px;position:relative}
ul.ticks li::before{content:"";position:absolute;left:4px;top:12px;width:9px;height:5px;
  border-left:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg)}
.plan.current{border-color:var(--accent)}

footer.bottom{border-top:1px solid var(--line);padding:24px 0;color:var(--dim);font-size:13px}
footer.bottom .row{display:flex;flex-wrap:wrap;gap:18px;justify-content:space-between}

.hero{padding:44px 0 12px}
.hero h1{font-size:42px;line-height:1.12;max-width:22ch}
.hero .lead{font-size:18px;margin-top:14px}
.mark{color:var(--text)}
.strike{color:var(--dim);text-decoration:line-through}
@media (max-width:640px){
  .hero h1{font-size:32px}
  .row2{grid-template-columns:1fr}
  nav.links{gap:14px;font-size:13px}
}
`;

export type LayoutOptions = {
  title: string;
  description?: string;
  user?: UserRow | null;
  active?: string;
  wide?: boolean;
  narrow?: boolean;
};

export function page(options: LayoutOptions, body: Raw): Raw {
  const { user } = options;

  const nav = user
    ? html`
        <nav class="links">
          <a href="/dashboard" class="${options.active === 'dashboard' ? 'active' : ''}">Monitors</a>
          <a href="/incidents" class="${options.active === 'incidents' ? 'active' : ''}">Incidents</a>
          <a href="/settings" class="${options.active === 'settings' ? 'active' : ''}">Settings</a>
          <a href="/billing" class="${options.active === 'billing' ? 'active' : ''}">Billing</a>
          <a href="/docs" class="${options.active === 'docs' ? 'active' : ''}">Docs</a>
        </nav>
      `
    : html`
        <nav class="links">
          <a href="/#how">How it works</a>
          <a href="/#pricing">Pricing</a>
          <a href="/docs">Docs</a>
          <a href="/login">Sign in</a>
        </nav>
      `;

  const wrapClass = options.narrow ? 'wrap narrow' : 'wrap';

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${options.title}</title>
<meta name="description" content="${options.description ?? 'Driftwatch monitors the third-party APIs you depend on and alerts you the moment their responses change shape.'}">
<meta name="color-scheme" content="dark">
<style>${raw(STYLES)}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="row">
      <a class="brand" href="${user ? '/dashboard' : '/'}"><span class="dot"></span> Driftwatch</a>
      ${nav}
    </div>
  </div>
</header>
<main><div class="${wrapClass}">${body}</div></main>
<footer class="bottom">
  <div class="wrap">
    <div class="row">
      <span>Driftwatch — contract monitoring for APIs you don't control.</span>
      <span><a href="/docs">Docs</a> · <a href="/status">Status</a> · <a href="/#pricing">Pricing</a></span>
    </div>
  </div>
</footer>
</body>
</html>`;
}

export function notice(kind: 'ok' | 'err' | 'warn', message: string): Raw {
  return html`<div class="notice ${kind}">${message}</div>`;
}

export function severityBadge(severity: string): Raw {
  const known = severity === 'breaking' || severity === 'warning' || severity === 'info';
  return html`<span class="badge ${known ? severity : 'muted'}">${severity.toUpperCase()}</span>`;
}

/** Turn `?status=` query flags into a banner, so redirects can carry feedback. */
export function flash(status: string | null): Raw | '' {
  if (!status) return '';
  const messages: Record<string, [('ok' | 'err' | 'warn'), string]> = {
    created: ['ok', 'Monitor created. The first check runs within a few seconds.'],
    updated: ['ok', 'Changes saved.'],
    deleted: ['ok', 'Monitor deleted.'],
    reset: ['ok', 'Baseline cleared. The next check will re-learn the response shape.'],
    paused: ['ok', 'Monitor paused.'],
    resumed: ['ok', 'Monitor resumed.'],
    'channel-added': ['ok', 'Notification channel added.'],
    'channel-removed': ['ok', 'Notification channel removed.'],
    'key-deleted': ['ok', 'API key revoked.'],
    acknowledged: ['ok', 'Incident acknowledged.'],
    success: ['ok', 'Subscription active. Thanks for the business.'],
    cancelled: ['warn', 'Checkout cancelled — nothing was charged.'],
    'limit-reached': ['err', 'You have reached your plan’s monitor limit.'],
    'plan-required': ['err', 'That feature needs a paid plan.'],
    'invalid-url': ['err', 'That URL could not be used. It must be a public http(s) endpoint.'],
    'invalid-email': ['err', 'That email address does not look right.'],
    'invalid-input': ['err', 'Some of those values were not valid. Nothing was saved.'],
    'billing-unavailable': ['err', 'Billing is not configured on this instance.'],
    expired: ['err', 'That sign-in link has expired or was already used.'],
  };
  const entry = messages[status];
  return entry ? notice(entry[0], entry[1]) : '';
}
