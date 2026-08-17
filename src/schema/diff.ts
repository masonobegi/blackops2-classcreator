import { describe, isNullable, type SchemaNode } from './infer.ts';
import { isIgnored } from './paths.ts';

/**
 * Severity is judged from the point of view of the *consumer* of the API —
 * our customer. Anything that can make their existing deserialiser throw or
 * silently read `undefined` is breaking. Anything they can ignore is info.
 */
export type Severity = 'breaking' | 'warning' | 'info';

export type ChangeKind =
  | 'field_removed'
  | 'field_added'
  | 'became_optional'
  | 'became_required'
  | 'type_changed'
  | 'became_nullable'
  | 'no_longer_nullable'
  | 'type_widened'
  | 'type_narrowed'
  | 'format_changed'
  | 'status_changed'
  | 'content_type_changed'
  | 'unobservable';

export type Change = {
  path: string;
  kind: ChangeKind;
  severity: Severity;
  from: string;
  to: string;
  message: string;
};

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, breaking: 2 };

export function maxSeverity(changes: readonly Change[]): Severity {
  let worst: Severity = 'info';
  for (const change of changes) {
    if (SEVERITY_RANK[change.severity] > SEVERITY_RANK[worst]) worst = change.severity;
  }
  return worst;
}

export function severityAtLeast(actual: Severity, minimum: Severity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[minimum];
}

export function countBySeverity(changes: readonly Change[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { breaking: 0, warning: 0, info: 0 };
  for (const change of changes) counts[change.severity]++;
  return counts;
}

/** Compare two schemas and return every difference, worst first. */
export function diffSchemas(
  before: SchemaNode,
  after: SchemaNode,
  ignorePaths: readonly string[] = [],
): Change[] {
  const changes: Change[] = [];
  walk('$', before, after, changes);
  const kept = changes.filter((change) => !isIgnored(change.path, ignorePaths));
  return kept.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function child(parent: string, key: string): string {
  return parent === '$' ? `$.${key}` : `${parent}.${key}`;
}

function walk(path: string, before: SchemaNode, after: SchemaNode, out: Change[]): void {
  // Nullability is tracked at the union level but reported on its own, because
  // "this field can now be null" is the single most common silent breakage.
  const wasNullable = isNullable(before);
  const isNowNullable = isNullable(after);
  if (!wasNullable && isNowNullable) {
    out.push({
      path,
      kind: 'became_nullable',
      severity: 'breaking',
      from: describe(before),
      to: describe(after),
      message: `${path} can now be null`,
    });
  } else if (wasNullable && !isNowNullable) {
    out.push({
      path,
      kind: 'no_longer_nullable',
      severity: 'info',
      from: describe(before),
      to: describe(after),
      message: `${path} is no longer nullable`,
    });
  }

  // A bare `null` observation carries no shape information beyond nullability,
  // and the block above has already reported that. Continuing would report one
  // fact twice (as both `became_nullable` and `type_changed`) and, in the
  // null -> concrete direction, would invent a breaking change out of a field
  // that merely started carrying data.
  if (before.t === 'null' || after.t === 'null') {
    if (before.t === 'union' || after.t === 'union') {
      const narrowing = after.t === 'null';
      out.push({
        path,
        kind: narrowing ? 'type_narrowed' : 'type_widened',
        severity: 'info',
        from: describe(before),
        to: describe(after),
        message: narrowing
          ? `${path} is now always null`
          : `${path} now carries ${describe(after)} rather than only null`,
      });
    }
    return;
  }

  if (before.t === 'union' || after.t === 'union') {
    walkUnion(path, before, after, out);
    return;
  }

  if (before.t !== after.t) {
    out.push({
      path,
      kind: 'type_changed',
      severity: 'breaking',
      from: describe(before),
      to: describe(after),
      message: `${path} changed from ${describe(before)} to ${describe(after)}`,
    });
    return;
  }

  if (before.t === 'object' && after.t === 'object') {
    walkObject(path, before.props, after.props, out);
    return;
  }

  if (before.t === 'array' && after.t === 'array') {
    if (before.items === null || after.items === null) {
      // One side was an empty array, so there is nothing to compare. Saying so
      // beats inventing a change that is really just a quiet Tuesday.
      if (before.items !== after.items) {
        out.push({
          path: `${path}[]`,
          kind: 'unobservable',
          severity: 'info',
          from: describe(before.items),
          to: describe(after.items),
          message:
            before.items === null
              ? `${path} was empty before, so its element shape is newly observed`
              : `${path} is now empty, so element changes cannot be detected`,
        });
      }
      return;
    }
    walk(`${path}[]`, before.items, after.items, out);
    return;
  }

  if (before.t === 'string' && after.t === 'string' && before.fmt !== after.fmt) {
    out.push({
      path,
      kind: 'format_changed',
      severity: 'warning',
      from: describe(before),
      to: describe(after),
      message: `${path} format changed from ${before.fmt ?? 'unformatted'} to ${after.fmt ?? 'unformatted'}`,
    });
  }
}

function walkObject(
  path: string,
  before: Record<string, { schema: SchemaNode; optional: boolean }>,
  after: Record<string, { schema: SchemaNode; optional: boolean }>,
  out: Change[],
): void {
  for (const key of Object.keys(before)) {
    const left = before[key]!;
    const right = after[key];
    const fieldPath = child(path, key);

    if (!right) {
      out.push({
        path: fieldPath,
        kind: 'field_removed',
        severity: 'breaking',
        from: describe(left.schema),
        to: 'absent',
        message: `${fieldPath} was removed`,
      });
      continue;
    }

    if (!left.optional && right.optional) {
      out.push({
        path: fieldPath,
        kind: 'became_optional',
        severity: 'breaking',
        from: 'always present',
        to: 'sometimes absent',
        message: `${fieldPath} is no longer always present`,
      });
    } else if (left.optional && !right.optional) {
      out.push({
        path: fieldPath,
        kind: 'became_required',
        severity: 'info',
        from: 'sometimes absent',
        to: 'always present',
        message: `${fieldPath} is now always present`,
      });
    }

    walk(fieldPath, left.schema, right.schema, out);
  }

  for (const key of Object.keys(after)) {
    if (before[key]) continue;
    const fieldPath = child(path, key);
    const right = after[key]!;
    out.push({
      path: fieldPath,
      kind: 'field_added',
      severity: 'info',
      from: 'absent',
      to: describe(right.schema),
      message: `${fieldPath} was added (${describe(right.schema)})`,
    });
  }
}

function walkUnion(path: string, before: SchemaNode, after: SchemaNode, out: Change[]): void {
  const beforeMembers = members(before);
  const afterMembers = members(after);

  // Nullability already produced its own change above; don't double-report it.
  const added = [...afterMembers.keys()].filter((t) => !beforeMembers.has(t) && t !== 'null');
  const removed = [...beforeMembers.keys()].filter((t) => !afterMembers.has(t) && t !== 'null');

  for (const kind of added) {
    out.push({
      path,
      kind: 'type_widened',
      severity: 'warning',
      from: describe(before),
      to: describe(after),
      message: `${path} can now also be ${kind}`,
    });
  }
  for (const kind of removed) {
    out.push({
      path,
      kind: 'type_narrowed',
      severity: 'info',
      from: describe(before),
      to: describe(after),
      message: `${path} is no longer ever ${kind}`,
    });
  }

  // Recurse into members present on both sides so nested changes still surface.
  for (const [kind, beforeNode] of beforeMembers) {
    const afterNode = afterMembers.get(kind);
    if (!afterNode || kind === 'null') continue;
    if (beforeNode.t === 'object' || beforeNode.t === 'array') {
      walk(path, beforeNode, afterNode, out);
    }
  }
}

function members(node: SchemaNode): Map<string, SchemaNode> {
  const map = new Map<string, SchemaNode>();
  if (node.t === 'union') {
    for (const member of node.of) map.set(member.t, member);
  } else {
    map.set(node.t, node);
  }
  return map;
}

/** Non-schema signals that matter just as much as the body shape. */
export function diffResponseMeta(
  before: { status: number; contentType: string },
  after: { status: number; contentType: string },
): Change[] {
  const changes: Change[] = [];
  if (before.status !== after.status) {
    changes.push({
      path: '$status',
      kind: 'status_changed',
      severity: 'breaking',
      from: String(before.status),
      to: String(after.status),
      message: `HTTP status changed from ${before.status} to ${after.status}`,
    });
  }
  if (before.contentType !== after.contentType) {
    changes.push({
      path: '$contentType',
      kind: 'content_type_changed',
      severity: 'breaking',
      from: before.contentType || 'unknown',
      to: after.contentType || 'unknown',
      message: `Content-Type changed from ${before.contentType || 'unknown'} to ${after.contentType || 'unknown'}`,
    });
  }
  return changes;
}

/** One-line headline for an alert subject. */
export function summarize(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No changes';
  const counts = countBySeverity(changes);
  const first = changes[0]!;
  const others = changes.length - 1;
  const tail = others > 0 ? ` and ${others} other change${others === 1 ? '' : 's'}` : '';
  const prefix = counts.breaking > 0 ? 'Breaking: ' : counts.warning > 0 ? 'Warning: ' : '';
  return `${prefix}${first.message}${tail}`;
}
