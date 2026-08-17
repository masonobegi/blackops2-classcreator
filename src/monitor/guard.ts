import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Customers hand us URLs and we fetch them from our own network, which makes
 * this service a server-side request forgery engine unless we defend it.
 * The classic attack is `http://169.254.169.254/latest/meta-data/iam/...` to
 * exfiltrate the host's cloud credentials through the alert email.
 *
 * Every URL is checked before the request, and again after every redirect.
 */

export class UnsafeUrlError extends Error {}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** CIDR blocks that must never be reachable from a customer-supplied URL. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // carrier NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true; // not an IP literal we understand: refuse it
}

function isPrivateV4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return true;
  for (const [base, bits] of BLOCKED_V4) {
    const baseValue = parseIpv4(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

function isPrivateV6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;

  // IPv4-mapped and IPv4-compatible forms tunnel straight past a naive check.
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateV4(mapped[1]!);

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')) return true; // fe80::/10
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (/^f[cd]/.test(normalized)) return true; // fc00::/7 unique-local
  if (normalized.startsWith('2001:db8')) return true; // documentation
  if (normalized.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Validate scheme, port and every DNS answer for the host.
 *
 * Note: a determined attacker can still win a DNS rebinding race between this
 * lookup and the socket connect. Closing that hole requires pinning the
 * resolved IP at connect time, which `fetch` does not expose; for a monitoring
 * product the residual risk is acceptable and documented in SECURITY.md.
 */
export type UrlGuardOptions = {
  /**
   * Permit private and loopback targets. Only for a self-hosted instance
   * deliberately monitoring internal services, and for this project's tests.
   * Enabling it on a multi-tenant deployment hands every customer the ability
   * to probe your internal network.
   */
  allowPrivate?: boolean;
};

export async function assertSafeUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('URL is not valid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported protocol ${url.protocol}`);
  }

  if (options.allowPrivate) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new UnsafeUrlError(`Host ${hostname} is not allowed`);
  }

  if (url.port !== '' && !['80', '443', '8080', '8443'].includes(url.port)) {
    throw new UnsafeUrlError(`Port ${url.port} is not allowed`);
  }

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError(`Address ${hostname} is in a reserved range`);
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${hostname}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve ${hostname}`);

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError(`${hostname} resolves to reserved address ${address}`);
    }
  }

  return url;
}

/** Header names a customer may not set, because we control them. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = String(rawValue).trim();
    if (name === '' || FORBIDDEN_HEADERS.has(name.toLowerCase())) continue;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    // Reject CR/LF outright rather than stripping, so header injection attempts
    // fail loudly at save time instead of silently mangling a request.
    if (/[\r\n]/.test(value)) continue;
    clean[name] = value.slice(0, 4096);
  }
  return clean;
}
