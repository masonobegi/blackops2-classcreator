import { html, type Raw } from '../lib/html.ts';
import { formatInterval, parseJson, timeAgo } from '../lib/util.ts';
import { PLANS, type Plan, type PlanId } from '../plans.ts';
import type { Change } from '../schema/diff.ts';
import { countBySeverity } from '../schema/diff.ts';
import type { SchemaNode } from '../schema/infer.ts';
import { countFields, printSchema } from '../schema/print.ts';
import type {
  ApiKeyRow,
  ChannelRow,
  IncidentRow,
  MonitorRow,
  SnapshotRow,
  UserRow,
} from '../store.ts';
import { flash, page, severityBadge } from './layout.ts';
import { pricingSection } from './marketing.ts';

const INTERVAL_CHOICES: [number, string][] = [
  [60, 'Every minute'],
  [300, 'Every 5 minutes'],
  [900, 'Every 15 minutes'],
  [1800, 'Every 30 minutes'],
  [3600, 'Every hour'],
  [21600, 'Every 6 hours'],
  [86400, 'Every day'],
];

function csrfField(csrf: string): Raw {
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}

function monitorStatusBadge(monitor: MonitorRow): Raw {
  if (monitor.status === 'paused') {
    return html`<span class="badge muted">paused</span>`;
  }
  if (monitor.consecutive_failures > 0) {
    return html`<span class="badge warning">failing</span>`;
  }
  if (monitor.baseline_hash === null) {
    return html`<span class="badge info">learning</span>`;
  }
  return html`<span class="badge ok">watching</span>`;
}

// ------------------------------------------------------------- dashboard -----

export function dashboardPage(
  user: UserRow,
  plan: Plan,
  monitors: MonitorRow[],
  incidents: IncidentRow[],
  status: string | null,
): Raw {
  const breakingCount = incidents.filter((i) => i.severity === 'breaking').length;
  const watching = monitors.filter((m) => m.status === 'active').length;

  return page(
    { title: 'Monitors — Driftwatch', user, active: 'dashboard' },
    html`
      ${flash(status)}
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div>
          <h1>Monitors</h1>
          <p class="sub" style="margin:0">
            ${plan.name} plan · ${monitors.length} of ${plan.monitors} monitors used ·
            minimum interval ${formatInterval(plan.minIntervalSeconds)}
          </p>
        </div>
        <div class="actions">
          ${monitors.length >= plan.monitors
            ? html`<a class="btn secondary" href="/billing">Upgrade for more</a>`
            : html`<a class="btn" href="/monitors/new">New monitor</a>`}
        </div>
      </div>

      <div class="grid c4" style="margin:24px 0 8px">
        <div class="stat"><div class="k">Watching</div><div class="v">${watching}</div></div>
        <div class="stat"><div class="k">Checks run</div>
          <div class="v">${monitors.reduce((sum, m) => sum + m.total_checks, 0)}</div></div>
        <div class="stat"><div class="k">Incidents (30d)</div><div class="v">${incidents.length}</div></div>
        <div class="stat"><div class="k">Breaking (30d)</div>
          <div class="v" style="${breakingCount > 0 ? 'color:var(--breaking)' : ''}">${breakingCount}</div></div>
      </div>

      ${monitors.length === 0
        ? html`
            <div class="empty" style="margin-top:20px">
              <p style="margin:0 0 14px">
                No monitors yet. Point one at an API you'd rather not hear about from a customer.
              </p>
              <a class="btn" href="/monitors/new">Create your first monitor</a>
            </div>
          `
        : html`
            <div class="card" style="margin-top:20px;padding:16px 4px">
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Monitor</th><th>State</th><th>Every</th>
                      <th>Last check</th><th>Incidents</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${monitors.map(
                      (monitor) => html`
                        <tr class="clickable">
                          <td>
                            <a href="/monitors/${monitor.id}"><strong>${monitor.name}</strong></a>
                            <div class="url">${monitor.method} ${monitor.url}</div>
                            ${monitor.pause_reason
                              ? html`<div class="url" style="color:var(--warning)">${monitor.pause_reason}</div>`
                              : ''}
                          </td>
                          <td>${monitorStatusBadge(monitor)}</td>
                          <td class="mono" style="font-size:13px">${formatInterval(monitor.interval_seconds)}</td>
                          <td style="font-size:13px;color:var(--muted)">${timeAgo(monitor.last_run_at)}</td>
                          <td style="font-size:13px;color:var(--muted)">${monitor.total_incidents}</td>
                          <td style="text-align:right">
                            <a class="btn small secondary" href="/monitors/${monitor.id}">Open</a>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          `}

      ${incidents.length > 0
        ? html`
            <h2>Recent incidents</h2>
            ${incidentTable(incidents.slice(0, 8), monitors)}
            <p style="margin-top:14px"><a href="/incidents">All incidents →</a></p>
          `
        : ''}
    `,
  );
}

// ----------------------------------------------------------- monitor form ----

export function monitorFormPage(
  user: UserRow,
  csrf: string,
  plan: Plan,
  monitor: MonitorRow | null,
  status: string | null,
): Raw {
  const isNew = monitor === null;
  const headers = parseJson<Record<string, string>>(monitor?.headers_json, {});
  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  const ignorePaths = parseJson<string[]>(monitor?.ignore_paths_json, []).join('\n');
  const action = isNew ? '/monitors' : `/monitors/${monitor.id}`;

  return page(
    { title: `${isNew ? 'New' : 'Edit'} monitor — Driftwatch`, user, active: 'dashboard', narrow: true },
    html`
      ${flash(status)}
      <h1>${isNew ? 'New monitor' : 'Edit monitor'}</h1>
      <p class="sub">
        The first check runs immediately and becomes the baseline. Nothing alerts until
        the shape changes.
      </p>

      <form method="post" action="${action}" class="card">
        ${csrfField(csrf)}
        <div class="field">
          <label for="name">Name
            <span class="hint">How it appears in alerts. e.g. “Stripe invoices” or “Partner catalogue”.</span>
          </label>
          <input id="name" name="name" type="text" required maxlength="120"
                 value="${monitor?.name ?? ''}" placeholder="Vendor billing API">
        </div>

        <div class="row2">
          <div class="field">
            <label for="method">Method</label>
            <select id="method" name="method">
              ${['GET', 'POST', 'PUT', 'HEAD'].map(
                (verb) => html`
                  <option value="${verb}" ${monitor?.method === verb ? 'selected' : ''}>${verb}</option>
                `,
              )}
            </select>
          </div>
          <div class="field">
            <label for="interval_seconds">Check interval</label>
            <select id="interval_seconds" name="interval_seconds">
              ${INTERVAL_CHOICES.filter(([seconds]) => seconds >= plan.minIntervalSeconds).map(
                ([seconds, label]) => html`
                  <option value="${seconds}" ${monitor?.interval_seconds === seconds ? 'selected' : ''}>
                    ${label}
                  </option>
                `,
              )}
            </select>
          </div>
        </div>

        <div class="field">
          <label for="url">URL
            <span class="hint">Must be a public https endpoint that returns JSON.</span>
          </label>
          <input id="url" name="url" type="url" required value="${monitor?.url ?? ''}"
                 placeholder="https://api.vendor.com/v2/invoices">
        </div>

        <div class="field">
          <label for="headers">Request headers
            <span class="hint">One per line, <code>Name: value</code>. Use a read-only token.</span>
          </label>
          <textarea id="headers" name="headers" rows="3"
                    placeholder="authorization: Bearer sk_readonly_...">${headerText}</textarea>
        </div>

        <div class="field">
          <label for="body">Request body
            <span class="hint">Optional; sent for POST and PUT only.</span>
          </label>
          <textarea id="body" name="body" rows="3" placeholder='{"query":"..."}'>${monitor?.body ?? ''}</textarea>
        </div>

        <div class="field">
          <label for="ignore_paths">Ignore paths
            <span class="hint">
              One glob per line. Use for fields that legitimately change every request —
              request ids, timestamps, cursors. See <a href="/docs">the syntax</a>.
            </span>
          </label>
          <textarea id="ignore_paths" name="ignore_paths" rows="4"
                    placeholder="$.meta.request_id&#10;$.**.server_time">${ignorePaths}</textarea>
        </div>

        <div class="row2">
          <div class="field">
            <label for="min_severity">Alert me about
              <span class="hint">Overrides your account default for this monitor.</span>
            </label>
            <select id="min_severity" name="min_severity">
              <option value="" ${monitor?.min_severity === null ? 'selected' : ''}>Account default</option>
              <option value="breaking" ${monitor?.min_severity === 'breaking' ? 'selected' : ''}>Breaking only</option>
              <option value="warning" ${monitor?.min_severity === 'warning' ? 'selected' : ''}>Breaking + warnings</option>
              <option value="info" ${monitor?.min_severity === 'info' ? 'selected' : ''}>Everything</option>
            </select>
          </div>
          <div class="field">
            <label for="confirmations">Confirmations
              <span class="hint">Consecutive identical checks before alerting.</span>
            </label>
            <select id="confirmations" name="confirmations">
              ${[1, 2, 3, 4].map(
                (n) => html`
                  <option value="${n}" ${(monitor?.confirmations ?? 2) === n ? 'selected' : ''}>
                    ${n} check${n === 1 ? '' : 's'}
                  </option>
                `,
              )}
            </select>
          </div>
        </div>

        <div class="actions">
          <button class="btn" type="submit">${isNew ? 'Create monitor' : 'Save changes'}</button>
          <a class="btn secondary" href="${isNew ? '/dashboard' : `/monitors/${monitor.id}`}">Cancel</a>
        </div>
      </form>
    `,
  );
}

// --------------------------------------------------------- monitor detail ----

export function monitorDetailPage(
  user: UserRow,
  csrf: string,
  monitor: MonitorRow,
  incidents: IncidentRow[],
  snapshots: SnapshotRow[],
  status: string | null,
): Raw {
  const baseline = parseJson<SchemaNode | null>(monitor.baseline_schema_json, null);
  const latency = snapshots.filter((s) => s.latency_ms !== null).map((s) => s.latency_ms!);
  const medianLatency =
    latency.length === 0
      ? null
      : [...latency].sort((a, b) => a - b)[Math.floor(latency.length / 2)]!;
  const ignorePaths = parseJson<string[]>(monitor.ignore_paths_json, []);

  return page(
    { title: `${monitor.name} — Driftwatch`, user, active: 'dashboard' },
    html`
      ${flash(status)}
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="min-width:0">
          <h1 style="margin-bottom:6px">${monitor.name} ${monitorStatusBadge(monitor)}</h1>
          <div class="url">${monitor.method} ${monitor.url}</div>
        </div>
        <div class="actions">
          <a class="btn secondary small" href="/monitors/${monitor.id}/edit">Edit</a>
          <form method="post" action="/monitors/${monitor.id}/check" style="display:inline">
            ${csrfField(csrf)}
            <button class="btn secondary small" type="submit">Check now</button>
          </form>
          <form method="post" action="/monitors/${monitor.id}/toggle" style="display:inline">
            ${csrfField(csrf)}
            <button class="btn secondary small" type="submit">
              ${monitor.status === 'active' ? 'Pause' : 'Resume'}
            </button>
          </form>
        </div>
      </div>

      ${monitor.pause_reason ? html`<div class="notice warn" style="margin-top:18px">${monitor.pause_reason}</div>` : ''}

      <div class="grid c4" style="margin:24px 0">
        <div class="stat"><div class="k">Checks</div><div class="v">${monitor.total_checks}</div></div>
        <div class="stat"><div class="k">Incidents</div><div class="v">${monitor.total_incidents}</div></div>
        <div class="stat"><div class="k">Median latency</div>
          <div class="v">${medianLatency === null ? '—' : medianLatency}<small> ms</small></div></div>
        <div class="stat"><div class="k">Fields tracked</div><div class="v">${countFields(baseline)}</div></div>
      </div>

      <div class="grid c2">
        <div class="card">
          <h3>Current baseline</h3>
          <p style="font-size:13px;margin-bottom:10px">
            ${monitor.baseline_at === null
              ? 'Waiting for the first successful check.'
              : html`Learned ${timeAgo(monitor.baseline_at)} · HTTP ${monitor.baseline_status} ·
                     <span class="mono">${monitor.baseline_content_type}</span>`}
          </p>
          <pre class="code" style="max-height:420px;overflow:auto">${printSchema(baseline)}</pre>
          <form method="post" action="/monitors/${monitor.id}/reset">
            ${csrfField(csrf)}
            <button class="btn secondary small" type="submit">Forget baseline and re-learn</button>
          </form>
        </div>

        <div class="card">
          <h3>Configuration</h3>
          <table>
            <tbody>
              <tr><td>Interval</td><td class="mono">${formatInterval(monitor.interval_seconds)}</td></tr>
              <tr><td>Confirmations</td><td class="mono">${monitor.confirmations}</td></tr>
              <tr><td>Alert threshold</td>
                  <td class="mono">${monitor.min_severity ?? `${user.alert_min_severity} (account)`}</td></tr>
              <tr><td>Next check</td><td class="mono">${new Date(monitor.next_run_at).toISOString().slice(11, 19)}Z</td></tr>
              <tr><td>Consecutive failures</td><td class="mono">${monitor.consecutive_failures}</td></tr>
              <tr><td>Pending change</td>
                  <td class="mono">${monitor.pending_count > 0 ? `seen ${monitor.pending_count}×` : 'none'}</td></tr>
            </tbody>
          </table>
          <h3>Ignored paths</h3>
          ${ignorePaths.length === 0
            ? html`<p style="font-size:13px;margin:0">None. Add some if this monitor gets noisy.</p>`
            : html`<pre class="code" style="margin:0">${ignorePaths.join('\n')}</pre>`}
        </div>
      </div>

      <h2>Incidents</h2>
      ${incidents.length === 0
        ? html`<div class="empty">Nothing has changed since the baseline was learned.</div>`
        : incidentTable(incidents, [monitor])}

      <h2>Recent checks</h2>
      <div class="card" style="padding:16px 4px">
        <div class="scroll">
          <table>
            <thead><tr><th>When</th><th>Result</th><th>Status</th><th>Latency</th><th>Shape</th></tr></thead>
            <tbody>
              ${snapshots.slice(0, 25).map(
                (snapshot) => html`
                  <tr>
                    <td style="color:var(--muted);font-size:13px">${timeAgo(snapshot.created_at)}</td>
                    <td>
                      ${snapshot.ok === 1
                        ? html`<span class="badge ok">ok</span>`
                        : html`<span class="badge warning">failed</span>`}
                      ${snapshot.error ? html`<div class="url">${snapshot.error}</div>` : ''}
                    </td>
                    <td class="mono" style="font-size:13px">${snapshot.status_code ?? '—'}</td>
                    <td class="mono" style="font-size:13px">${snapshot.latency_ms ?? '—'}ms</td>
                    <td class="mono" style="font-size:12px;color:var(--dim)">${snapshot.schema_hash ?? '—'}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      </div>

      <hr>
      <form method="post" action="/monitors/${monitor.id}/delete">
        ${csrfField(csrf)}
        <button class="btn danger small" type="submit">Delete this monitor</button>
      </form>
    `,
  );
}

// --------------------------------------------------------------- incidents ---

export function incidentTable(incidents: IncidentRow[], monitors: MonitorRow[]): Raw {
  const names = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  return html`
    <div class="card" style="padding:16px 4px">
      <div class="scroll">
        <table>
          <thead><tr><th>When</th><th>Severity</th><th>Monitor</th><th>Summary</th><th></th></tr></thead>
          <tbody>
            ${incidents.map(
              (incident) => html`
                <tr class="clickable">
                  <td style="color:var(--muted);font-size:13px;white-space:nowrap">
                    ${timeAgo(incident.created_at)}
                  </td>
                  <td>${severityBadge(incident.severity)}</td>
                  <td style="font-size:13px">${names.get(incident.monitor_id) ?? '—'}</td>
                  <td style="font-size:13.5px">${incident.summary}</td>
                  <td style="text-align:right">
                    <a class="btn small secondary" href="/incidents/${incident.id}">Diff</a>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function incidentsPage(
  user: UserRow,
  incidents: IncidentRow[],
  monitors: MonitorRow[],
  status: string | null,
): Raw {
  return page(
    { title: 'Incidents — Driftwatch', user, active: 'incidents' },
    html`
      ${flash(status)}
      <h1>Incidents</h1>
      <p class="sub">Every confirmed change to a contract you are watching.</p>
      ${incidents.length === 0
        ? html`<div class="empty">No incidents yet. That is the goal.</div>`
        : incidentTable(incidents, monitors)}
    `,
  );
}

export function incidentDetailPage(
  user: UserRow,
  csrf: string,
  incident: IncidentRow,
  monitor: MonitorRow,
  status: string | null,
): Raw {
  const changes = parseJson<Change[]>(incident.changes_json, []);
  const counts = countBySeverity(changes);

  return page(
    { title: `Incident — Driftwatch`, user, active: 'incidents' },
    html`
      ${flash(status)}
      <p style="font-size:13px"><a href="/monitors/${monitor.id}">← ${monitor.name}</a></p>
      <h1 style="margin-bottom:8px">${severityBadge(incident.severity)} ${incident.summary}</h1>
      <p class="sub">
        ${new Date(incident.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC ·
        ${counts.breaking} breaking · ${counts.warning} warning · ${counts.info} info ·
        <span class="mono">${incident.from_hash ?? '—'} → ${incident.to_hash ?? '—'}</span>
      </p>

      ${changes.length === 0
        ? html`<div class="card"><p style="margin:0">
            No field-level diff for this incident — it was an availability or recovery event.
          </p></div>`
        : html`
            <div class="card" style="padding:16px 4px">
              <div class="scroll">
                <table>
                  <thead><tr><th>Severity</th><th>Path</th><th>Was</th><th>Now</th><th>What it means</th></tr></thead>
                  <tbody>
                    ${changes.map(
                      (change) => html`
                        <tr>
                          <td>${severityBadge(change.severity)}</td>
                          <td class="path">${change.path}</td>
                          <td class="mono" style="font-size:12.5px;color:var(--muted)">${change.from}</td>
                          <td class="mono" style="font-size:12.5px">${change.to}</td>
                          <td style="font-size:13px;color:var(--muted)">${change.message}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          `}

      <div class="actions" style="margin-top:20px">
        ${incident.acknowledged_at === null
          ? html`
              <form method="post" action="/incidents/${incident.id}/ack">
                ${csrfField(csrf)}
                <button class="btn secondary" type="submit">Acknowledge</button>
              </form>
            `
          : html`<span class="badge ok">acknowledged ${timeAgo(incident.acknowledged_at)}</span>`}
        <a class="btn secondary" href="/monitors/${monitor.id}">View current baseline</a>
      </div>

      <h2>Add an ignore rule</h2>
      <p>If any of these paths are expected to change, exclude them from future alerts.</p>
      <form method="post" action="/monitors/${monitor.id}/ignore" class="card">
        ${csrfField(csrf)}
        <div class="field">
          <label for="paths">Paths to ignore from now on</label>
          <textarea id="paths" name="paths" rows="3">${changes
            .filter((change) => change.severity !== 'breaking')
            .map((change) => change.path)
            .join('\n')}</textarea>
        </div>
        <button class="btn secondary" type="submit">Add to ignore list</button>
      </form>
    `,
  );
}

// ---------------------------------------------------------------- settings ---

export function settingsPage(
  user: UserRow,
  csrf: string,
  plan: Plan,
  channels: ChannelRow[],
  apiKeys: ApiKeyRow[],
  newKey: string | null,
  status: string | null,
): Raw {
  return page(
    { title: 'Settings — Driftwatch', user, active: 'settings' },
    html`
      ${flash(status)}
      <h1>Settings</h1>
      <p class="sub">Signed in as ${user.email}</p>

      <div class="card">
        <h3>Alert threshold</h3>
        <p>Applies to every monitor that does not override it.</p>
        <form method="post" action="/settings/severity" class="actions">
          ${csrfField(csrf)}
          <select name="alert_min_severity" style="max-width:260px">
            <option value="breaking" ${user.alert_min_severity === 'breaking' ? 'selected' : ''}>Breaking only</option>
            <option value="warning" ${user.alert_min_severity === 'warning' ? 'selected' : ''}>Breaking + warnings</option>
            <option value="info" ${user.alert_min_severity === 'info' ? 'selected' : ''}>Everything</option>
          </select>
          <button class="btn secondary" type="submit">Save</button>
        </form>
      </div>

      <div class="card">
        <h3>Notification channels <span class="badge muted">${channels.length}/${plan.channels}</span></h3>
        ${channels.length === 0
          ? html`<p>No channels. Alerts have nowhere to go.</p>`
          : html`
              <div class="scroll">
                <table>
                  <thead><tr><th>Kind</th><th>Destination</th><th>Secret</th><th></th></tr></thead>
                  <tbody>
                    ${channels.map(
                      (channel) => html`
                        <tr>
                          <td>
                            <span class="badge muted">${channel.kind}</span>
                            ${channel.disabled_at !== null ? html`<span class="badge warning">disabled</span>` : ''}
                          </td>
                          <td class="url">
                            ${channel.target}
                            ${channel.last_error
                              ? html`<div style="color:var(--warning)">${channel.last_error}</div>`
                              : ''}
                          </td>
                          <td class="mono" style="font-size:12px;color:var(--dim)">
                            ${channel.secret ?? '—'}
                          </td>
                          <td style="text-align:right">
                            <form method="post" action="/settings/channels/${channel.id}/delete">
                              ${csrfField(csrf)}
                              <button class="btn danger small" type="submit">Remove</button>
                            </form>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `}
        ${channels.length >= plan.channels
          ? html`<p style="margin-top:14px"><a href="/billing">Upgrade</a> to add more channels.</p>`
          : html`
              <form method="post" action="/settings/channels" style="margin-top:18px">
                ${csrfField(csrf)}
                <div class="row2">
                  <div class="field">
                    <label for="kind">Channel type</label>
                    <select id="kind" name="kind">
                      <option value="email">Email</option>
                      <option value="slack">Slack incoming webhook</option>
                      <option value="webhook">HTTP webhook (signed)</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="target">Destination
                      <span class="hint">Email address, or the webhook URL.</span>
                    </label>
                    <input id="target" name="target" type="text" required placeholder="oncall@company.com">
                  </div>
                </div>
                <button class="btn secondary" type="submit">Add channel</button>
              </form>
            `}
      </div>

      <div class="card">
        <h3>API keys</h3>
        ${!plan.apiAccess
          ? html`<p style="margin:0">The REST API is available on Pro and Team. <a href="/billing">Upgrade</a>.</p>`
          : html`
              ${newKey
                ? html`
                    <div class="notice ok">
                      Your new key — copy it now, it will not be shown again:
                      <pre class="code" style="margin:10px 0 0">${newKey}</pre>
                    </div>
                  `
                : ''}
              ${apiKeys.length === 0
                ? html`<p>No keys yet.</p>`
                : html`
                    <div class="scroll">
                      <table>
                        <thead><tr><th>Label</th><th>Prefix</th><th>Last used</th><th></th></tr></thead>
                        <tbody>
                          ${apiKeys.map(
                            (key) => html`
                              <tr>
                                <td>${key.label}</td>
                                <td class="mono" style="font-size:12.5px">${key.prefix}…</td>
                                <td style="font-size:13px;color:var(--muted)">${timeAgo(key.last_used_at)}</td>
                                <td style="text-align:right">
                                  <form method="post" action="/settings/keys/${key.id}/delete">
                                    ${csrfField(csrf)}
                                    <button class="btn danger small" type="submit">Revoke</button>
                                  </form>
                                </td>
                              </tr>
                            `,
                          )}
                        </tbody>
                      </table>
                    </div>
                  `}
              <form method="post" action="/settings/keys" class="actions" style="margin-top:18px">
                ${csrfField(csrf)}
                <input name="label" type="text" placeholder="CI pipeline" style="max-width:260px">
                <button class="btn secondary" type="submit">Create key</button>
              </form>
              <p style="margin:14px 0 0;font-size:13px">See <a href="/docs">the API docs</a>.</p>
            `}
      </div>

      <div class="card">
        <h3>Session</h3>
        <form method="post" action="/logout">
          ${csrfField(csrf)}
          <button class="btn secondary" type="submit">Sign out</button>
        </form>
      </div>
    `,
  );
}

// ----------------------------------------------------------------- billing ---

export function billingPage(
  user: UserRow,
  csrf: string,
  plan: Plan,
  billingEnabled: boolean,
  status: string | null,
): Raw {
  const periodEnd = user.current_period_end
    ? new Date(user.current_period_end).toISOString().slice(0, 10)
    : null;

  return page(
    { title: 'Billing — Driftwatch', user, active: 'billing' },
    html`
      ${flash(status)}
      <h1>Billing</h1>
      <p class="sub">
        You are on the <strong>${plan.name}</strong> plan${user.subscription_status
          ? html` · subscription <span class="mono">${user.subscription_status}</span>`
          : ''}${periodEnd ? html` · renews ${periodEnd}` : ''}.
      </p>

      ${!billingEnabled
        ? html`<div class="notice warn">
            Billing is not configured on this instance, so every account runs on the Free plan.
            Set <code>STRIPE_SECRET_KEY</code> and the price ids to enable paid plans.
          </div>`
        : user.stripe_customer_id
          ? html`
              <div class="card">
                <h3>Manage your subscription</h3>
                <p>
                  Update your card, download invoices, switch plans or cancel — all
                  self-serve in Stripe's portal.
                </p>
                <form method="post" action="/billing/portal">
                  ${csrfField(csrf)}
                  <button class="btn" type="submit">Open billing portal</button>
                </form>
              </div>
            `
          : ''}

      ${pricingSection(plan.id as PlanId)}

      <p style="font-size:13px;color:var(--dim)">
        Prices in USD. Plan changes take effect immediately; downgrades pause your
        oldest-first monitors beyond the new limit rather than deleting anything.
        ${plan.id !== 'free'
          ? html`Cancelling drops you to ${PLANS.free.monitors} monitors at
             ${formatInterval(PLANS.free.minIntervalSeconds)} checks.`
          : ''}
      </p>
    `,
  );
}
