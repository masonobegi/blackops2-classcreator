import type { SchemaNode } from './infer.ts';

/**
 * Render a schema as a readable pseudo-type. Shown on the monitor page so a
 * customer can see exactly what Driftwatch believes the contract to be — which
 * is the fastest way for them to spot a bad baseline or a field they should
 * be ignoring.
 */
export function printSchema(node: SchemaNode | null, indent = 0): string {
  if (node === null) return '(nothing observed yet)';
  const pad = '  '.repeat(indent);

  switch (node.t) {
    case 'object': {
      const keys = Object.keys(node.props).sort();
      if (keys.length === 0) return '{}';
      const lines = keys.map((key) => {
        const prop = node.props[key]!;
        const optional = prop.optional ? '?' : '';
        return `${pad}  ${key}${optional}: ${printSchema(prop.schema, indent + 1)}`;
      });
      return `{\n${lines.join('\n')}\n${pad}}`;
    }
    case 'array':
      return node.items === null ? 'array (empty)' : `${printSchema(node.items, indent)}[]`;
    case 'union':
      return node.of.map((member) => printSchema(member, indent)).join(' | ');
    case 'string':
      return node.fmt ? `string<${node.fmt}>` : 'string';
    default:
      return node.t;
  }
}

/** Count leaf fields, for a rough "size of contract" figure in the UI. */
export function countFields(node: SchemaNode | null): number {
  if (node === null) return 0;
  switch (node.t) {
    case 'object':
      return Object.values(node.props).reduce(
        (total, prop) => total + 1 + countFields(prop.schema),
        0,
      );
    case 'array':
      return countFields(node.items);
    case 'union':
      return node.of.reduce((total, member) => Math.max(total, countFields(member)), 0);
    default:
      return 0;
  }
}
