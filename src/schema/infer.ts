import { fingerprint } from '../lib/crypto.ts';

/**
 * A structural description of a JSON value.
 *
 * Deliberately coarser than JSON Schema: we do not distinguish integers from
 * floats, and we do not record enum members. Both produce a stream of false
 * "changes" for ordinary payloads (a price that is 10 today and 10.5 tomorrow,
 * a status field that gains a value) and false alarms are what kill a
 * monitoring product.
 */
export type SchemaNode =
  | { t: 'null' }
  | { t: 'bool' }
  | { t: 'number' }
  | { t: 'string'; fmt?: StringFormat }
  | { t: 'array'; items: SchemaNode | null }
  | { t: 'object'; props: Record<string, PropSchema> }
  | { t: 'union'; of: SchemaNode[] };

export type PropSchema = { schema: SchemaNode; optional: boolean };

export type StringFormat = 'datetime' | 'date' | 'uuid' | 'email' | 'url' | 'numeric' | 'empty';

/** Elements scanned per array. Enough to see optional fields, cheap to compute. */
const MAX_ARRAY_SAMPLE = 250;
/** Guard against pathological nesting in hostile or generated payloads. */
const MAX_DEPTH = 24;

const RE_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const RE_URL = /^https?:\/\/[^\s]+$/i;
const RE_NUMERIC = /^-?\d+(\.\d+)?$/;

export function detectFormat(value: string): StringFormat | undefined {
  if (value === '') return 'empty';
  if (value.length > 2048) return undefined;
  if (RE_DATETIME.test(value)) return 'datetime';
  if (RE_DATE.test(value)) return 'date';
  if (RE_UUID.test(value)) return 'uuid';
  if (RE_EMAIL.test(value)) return 'email';
  if (RE_URL.test(value)) return 'url';
  if (RE_NUMERIC.test(value)) return 'numeric';
  return undefined;
}

/** Build a schema describing a single observed JSON value. */
export function inferSchema(value: unknown, depth = 0): SchemaNode {
  if (value === null || value === undefined) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'bool' };
  if (typeof value === 'number') return { t: 'number' };
  if (typeof value === 'string') {
    const fmt = detectFormat(value);
    return fmt ? { t: 'string', fmt } : { t: 'string' };
  }

  if (depth >= MAX_DEPTH) return { t: 'string' };

  if (Array.isArray(value)) {
    if (value.length === 0) return { t: 'array', items: null };
    const sample = value.slice(0, MAX_ARRAY_SAMPLE);
    let items = inferSchema(sample[0], depth + 1);
    for (let i = 1; i < sample.length; i++) {
      items = mergeSchemas(items, inferSchema(sample[i], depth + 1));
    }
    return { t: 'array', items };
  }

  if (typeof value === 'object') {
    const props: Record<string, PropSchema> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      props[key] = { schema: inferSchema(child, depth + 1), optional: false };
    }
    return { t: 'object', props };
  }

  // Functions/symbols cannot appear in parsed JSON, but be total anyway.
  return { t: 'string' };
}

/**
 * Combine two observations of the same position into one schema.
 *
 * Merging is what turns "these 250 array elements" into "objects with an
 * optional `nickname`", which is the difference between a useful baseline and
 * an alert every time a list happens to contain a sparse record.
 */
export function mergeSchemas(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (a.t === 'union' || b.t === 'union') {
    const members = [...flatten(a), ...flatten(b)];
    return unionOf(members);
  }

  if (a.t !== b.t) return unionOf([a, b]);

  switch (a.t) {
    case 'object': {
      const other = b as Extract<SchemaNode, { t: 'object' }>;
      const props: Record<string, PropSchema> = {};
      const keys = new Set([...Object.keys(a.props), ...Object.keys(other.props)]);
      for (const key of keys) {
        const left = a.props[key];
        const right = other.props[key];
        if (left && right) {
          props[key] = {
            schema: mergeSchemas(left.schema, right.schema),
            optional: left.optional || right.optional,
          };
        } else if (left) {
          props[key] = { schema: left.schema, optional: true };
        } else if (right) {
          props[key] = { schema: right.schema, optional: true };
        }
      }
      return { t: 'object', props };
    }
    case 'array': {
      const other = b as Extract<SchemaNode, { t: 'array' }>;
      if (a.items === null) return { t: 'array', items: other.items };
      if (other.items === null) return { t: 'array', items: a.items };
      return { t: 'array', items: mergeSchemas(a.items, other.items) };
    }
    case 'string': {
      const other = b as Extract<SchemaNode, { t: 'string' }>;
      // An empty string tells us nothing about the format, so it never
      // demotes a known format to "some string".
      if (a.fmt === 'empty') return other.fmt ? { t: 'string', fmt: other.fmt } : { t: 'string' };
      if (other.fmt === 'empty') return a.fmt ? { t: 'string', fmt: a.fmt } : { t: 'string' };
      if (a.fmt && a.fmt === other.fmt) return { t: 'string', fmt: a.fmt };
      return { t: 'string' };
    }
    default:
      return a;
  }
}

function flatten(node: SchemaNode): SchemaNode[] {
  return node.t === 'union' ? node.of.flatMap(flatten) : [node];
}

/** Build a union, collapsing members that describe the same kind. */
export function unionOf(members: SchemaNode[]): SchemaNode {
  const byKind = new Map<string, SchemaNode>();
  for (const member of members.flatMap(flatten)) {
    const existing = byKind.get(member.t);
    byKind.set(member.t, existing ? mergeSameKind(existing, member) : member);
  }
  const collapsed = [...byKind.values()];
  if (collapsed.length === 1) return collapsed[0]!;
  collapsed.sort((x, y) => x.t.localeCompare(y.t));
  return { t: 'union', of: collapsed };
}

function mergeSameKind(a: SchemaNode, b: SchemaNode): SchemaNode {
  return a.t === b.t && a.t !== 'union' ? mergeSchemas(a, b) : a;
}

/**
 * Canonical serialisation: object keys sorted, so two structurally identical
 * schemas always produce the same string and therefore the same fingerprint.
 */
export function canonicalize(node: SchemaNode): string {
  switch (node.t) {
    case 'object': {
      const entries = Object.keys(node.props)
        .sort()
        .map((key) => {
          const prop = node.props[key]!;
          return `${JSON.stringify(key)}${prop.optional ? '?' : ''}:${canonicalize(prop.schema)}`;
        });
      return `{${entries.join(',')}}`;
    }
    case 'array':
      return `[${node.items === null ? '' : canonicalize(node.items)}]`;
    case 'union':
      return `(${node.of.map(canonicalize).sort().join('|')})`;
    case 'string':
      return node.fmt ? `string<${node.fmt}>` : 'string';
    default:
      return node.t;
  }
}

export function schemaHash(node: SchemaNode): string {
  return fingerprint(canonicalize(node));
}

/** Short human-readable type, used in alert copy. */
export function describe(node: SchemaNode | null): string {
  if (node === null) return 'empty array';
  switch (node.t) {
    case 'object': {
      const count = Object.keys(node.props).length;
      return `object(${count} field${count === 1 ? '' : 's'})`;
    }
    case 'array':
      return `array<${node.items === null ? 'empty' : describe(node.items)}>`;
    case 'union':
      return node.of.map(describe).join(' | ');
    case 'string':
      return node.fmt ? `string(${node.fmt})` : 'string';
    default:
      return node.t;
  }
}

export function isNullable(node: SchemaNode): boolean {
  if (node.t === 'null') return true;
  return node.t === 'union' && node.of.some((member) => member.t === 'null');
}
