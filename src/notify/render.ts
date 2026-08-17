import type { Change, Severity } from '../schema/diff.ts';
import { countBySeverity } from '../schema/diff.ts';
import type { IncidentRow, MonitorRow } from '../store.ts';
import { escapeHtml } from '../lib/html.ts';

export type RenderedAlert = {
  subject: string;
  text: string;
  html: string;
  slack: unknown;
  json: unknown;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: 'BREAKING',
  warning: 'WARNING',
  info: 'INFO',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  breaking: '🔴',
  warning: '🟠',
  info: '🔵',
};

function parseChanges(incident: IncidentRow): Change[] {
  try {
    const parsed = JSON.parse(incident.changes_json);
    return Array.isArray(parsed) ? (parsed as Change[]) : [];
  } catch {
    return [];
  }
}

export function renderAlert(
  incident: IncidentRow,
  monitor: MonitorRow,
  baseUrl: string,
): RenderedAlert {
  const severity = incident.severity as Severity;
  const changes = parseChanges(incident);
  const counts = countBySeverity(changes);
  const link = `${baseUrl}/incidents/${incident.id}`;

  const subject =
    incident.kind === 'availability'
      ? `[Driftwatch] ${monitor.name} is failing`
      : incident.kind === 'recovery'
        ? `[Driftwatch] ${monitor.name} recovered`
        : `[Driftwatch] ${SEVERITY_LABEL[severity]} change in ${monitor.name}`;

  const headline = incident.summary;

  const textLines = [
    `${SEVERITY_EMOJI[severity]} ${SEVERITY_LABEL[severity]} — ${monitor.name}`,
    `${monitor.method} ${monitor.url}`,
    '',
    headline,
    '',
  ];

  if (changes.length > 0) {
    textLines.push(
      `${counts.breaking} breaking, ${counts.warning} warning, ${counts.info} informational`,
      '',
    );
    for (const change of changes.slice(0, 25)) {
      textLines.push(`  [${SEVERITY_LABEL[change.severity]}] ${change.message}`);
      if (change.from !== change.to) {
        textLines.push(`      ${change.from} -> ${change.to}`);
      }
    }
    if (changes.length > 25) textLines.push(`  ...and ${changes.length - 25} more`);
    textLines.push('');
  }

  textLines.push(`Full detail: ${link}`);

  const rows = changes
    .slice(0, 25)
    .map(
      (change) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #22252b;white-space:nowrap">
            <span style="font:600 11px/1 ui-monospace,monospace;color:${severityColor(change.severity)}">
              ${SEVERITY_LABEL[change.severity]}
            </span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #22252b;font:13px/1.5 ui-monospace,monospace;color:#e6e8eb">
            ${escapeHtml(change.path)}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #22252b;font:13px/1.5 -apple-system,sans-serif;color:#a8adb8">
            ${escapeHtml(change.message)}
          </td>
        </tr>`,
    )
    .join('');

  const html = `
<div style="background:#0f1115;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#16181d;border:1px solid #22252b;border-radius:12px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #22252b">
      <div style="font:600 12px/1 ui-monospace,monospace;letter-spacing:.08em;color:${severityColor(severity)}">
        ${SEVERITY_EMOJI[severity]} ${SEVERITY_LABEL[severity]}
      </div>
      <div style="margin-top:8px;font:600 20px/1.3 inherit;color:#f4f5f7">${escapeHtml(monitor.name)}</div>
      <div style="margin-top:4px;font:12px/1.5 ui-monospace,monospace;color:#7d838f;word-break:break-all">
        ${escapeHtml(monitor.method)} ${escapeHtml(monitor.url)}
      </div>
    </div>
    <div style="padding:20px 24px;font:15px/1.6 inherit;color:#e6e8eb">${escapeHtml(headline)}</div>
    ${
      rows === ''
        ? ''
        : `<table style="width:100%;border-collapse:collapse;border-top:1px solid #22252b">${rows}</table>`
    }
    ${
      changes.length > 25
        ? `<div style="padding:12px 24px;font:13px/1.5 inherit;color:#7d838f">…and ${changes.length - 25} more changes.</div>`
        : ''
    }
    <div style="padding:20px 24px;border-top:1px solid #22252b">
      <a href="${escapeHtml(link)}"
         style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f7cff;color:#fff;font:600 14px/1 inherit;text-decoration:none">
        View the diff
      </a>
    </div>
  </div>
  <div style="max-width:640px;margin:16px auto 0;font:12px/1.6 inherit;color:#6b7280;text-align:center">
    Driftwatch monitors the APIs you depend on.
    <a href="${escapeHtml(baseUrl)}/settings" style="color:#7d838f">Alert settings</a>
  </div>
</div>`.trim();

  const slack = {
    text: `${SEVERITY_EMOJI[severity]} ${SEVERITY_LABEL[severity]}: ${monitor.name} — ${headline}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${SEVERITY_EMOJI[severity]} *${SEVERITY_LABEL[severity]} — <${link}|${monitor.name}>*\n\`${monitor.method} ${monitor.url}\``,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
      ...(changes.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: changes
                  .slice(0, 10)
                  .map((change) => `• \`${change.path}\` — ${change.message}`)
                  .join('\n'),
              },
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${counts.breaking} breaking · ${counts.warning} warning · ${counts.info} info · <${link}|full diff>`,
          },
        ],
      },
    ],
  };

  const json = {
    type: `incident.${incident.kind}`,
    incident: {
      id: incident.id,
      severity: incident.severity,
      kind: incident.kind,
      summary: incident.summary,
      created_at: new Date(incident.created_at).toISOString(),
      url: link,
      from_schema: incident.from_hash,
      to_schema: incident.to_hash,
    },
    monitor: {
      id: monitor.id,
      name: monitor.name,
      method: monitor.method,
      url: monitor.url,
    },
    changes,
  };

  return { subject, text: textLines.join('\n'), html, slack, json };
}

function severityColor(severity: Severity): string {
  if (severity === 'breaking') return '#ff6b6b';
  if (severity === 'warning') return '#ffa94d';
  return '#4dabf7';
}
