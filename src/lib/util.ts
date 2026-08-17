export function parseJson<T>(input: string | null | undefined, fallback: T): T {
  if (input === null || input === undefined || input === '') return fallback;
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Run `worker` over `items` with a bounded number in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );

  return results;
}

const UNITS: [number, string][] = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
  [1_000, 's'],
];

export function timeAgo(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp === null || timestamp === undefined) return 'never';
  const delta = Math.max(0, now - timestamp);
  if (delta < 1000) return 'just now';
  for (const [size, label] of UNITS) {
    if (delta >= size) return `${Math.floor(delta / size)}${label} ago`;
  }
  return 'just now';
}

export function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
