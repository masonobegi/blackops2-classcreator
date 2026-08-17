/**
 * Minimal escaping template tag. Everything interpolated into `html` is escaped
 * unless explicitly wrapped in `raw()`, which makes XSS an opt-in mistake
 * rather than the default one.
 */

export type Raw = { __raw: string };

export function raw(value: string): Raw {
  return { __raw: value };
}

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && '__raw' in value;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (isRaw(value)) return value.__raw;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return raw(out);
}
