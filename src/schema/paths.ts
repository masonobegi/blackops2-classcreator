/**
 * Path matching for per-monitor ignore rules.
 *
 * Paths produced by the differ look like:
 *   $.data[].updated_at
 *   $.meta.request_id
 *   $status
 *
 * Patterns support `*` (one segment) and `**` (any number of segments):
 *   $.data[].updated_at   exact
 *   $.data[].*            every field of every element
 *   $.**.request_id       a field at any depth
 *   $.meta.**             the whole meta subtree
 *
 * Ignore rules are the pressure valve for noisy upstreams. Without them a
 * customer with a `server_time` field in every response gets paged forever and
 * then cancels, so this is a retention feature, not a nicety.
 */

export function splitPath(path: string): string[] {
  // "$.data[].id" -> ["data", "[]", "id"]; "$status" -> ["$status"]
  if (!path.startsWith('$.')) return [path];
  const segments: string[] = [];
  for (const chunk of path.slice(2).split('.')) {
    if (chunk === '') continue;
    // Strip every trailing `[]` so nested arrays keep one segment per level.
    let name = chunk;
    let arrays = 0;
    while (name.endsWith('[]')) {
      name = name.slice(0, -2);
      arrays++;
    }
    if (name !== '') segments.push(name);
    for (let i = 0; i < arrays; i++) segments.push('[]');
  }
  return segments;
}

export function matchPath(pattern: string, path: string): boolean {
  const normalized = pattern.trim();
  if (normalized === '') return false;
  if (normalized === path) return true;
  return matchSegments(splitPath(normalized), splitPath(path), 0, 0);
}

function matchSegments(pattern: string[], path: string[], p: number, s: number): boolean {
  if (p === pattern.length) return s === path.length;

  const token = pattern[p]!;
  if (token === '**') {
    // `**` also matches zero segments, so `$.meta.**` covers `$.meta` itself.
    for (let skip = s; skip <= path.length; skip++) {
      if (matchSegments(pattern, path, p + 1, skip)) return true;
    }
    return false;
  }

  if (s >= path.length) return false;
  const segment = path[s]!;
  const matches = token === '*' ? segment !== '[]' : token === segment;
  return matches && matchSegments(pattern, path, p + 1, s + 1);
}

export function isIgnored(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchPath(pattern, path));
}

/** Parse the textarea in the monitor form: one pattern per line. */
export function parseIgnorePaths(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .slice(0, 100);
}
