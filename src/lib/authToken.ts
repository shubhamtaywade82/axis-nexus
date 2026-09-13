import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison for bearer-token / shared-secret checks.
 *
 * Why this exists: a plain `presented !== expected` short-circuits on the
 * first byte that differs, leaking the secret's prefix length through
 * response-time side channels. `crypto.timingSafeEqual` requires
 * equal-length `Buffer` arguments and throws on length mismatch, so we
 * pre-compare lengths (length itself is not secret for a configured
 * bearer token) and then compare the bytes in constant time.
 *
 * Returns `false` (never throws) for any shape that isn't a matching
 * same-length string — safe to use directly in a request gate without
 * a try/catch.
 */
export function safeTokenCompare(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  if (presented.length !== expected.length) return false;
  // Both buffers are same length here — timingSafeEqual cannot throw.
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** Extracts a bearer token from an `Authorization: Bearer <token>` header.
 *  Returns the raw token string, or null if absent / malformed. */
export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
