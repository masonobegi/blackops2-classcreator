import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored hashed so a leaked database dump cannot be replayed as a
 * live session. SHA-256 is correct here (unlike for passwords) because the
 * input is already high-entropy random.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, stable identifier for a schema shape. */
export function fingerprint(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Sortable-ish public id: millisecond timestamp in base36 plus randomness.
 * Readable in URLs and roughly ordered by creation, which makes support and
 * log spelunking much easier than opaque UUIDs.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(8);
  let random = '';
  for (const byte of bytes) random += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${time}${random}`;
}
