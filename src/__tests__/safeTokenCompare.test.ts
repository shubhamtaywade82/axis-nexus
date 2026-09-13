import { extractBearer, safeTokenCompare } from '../lib/authToken';

describe('safeTokenCompare (constant-time bearer comparison)', () => {
  const secret = 'super-secret-bearer-token-1234567890';

  it('returns true for an exact match', () => {
    expect(safeTokenCompare(secret, secret)).toBe(true);
  });

  it('returns false for a different same-length string', () => {
    // Construct an attacker string with the EXACT same length as the secret
    // — the test specifically guards the length-mismatch short-circuit.
    const attacker = 'a'.repeat(secret.length);
    expect(attacker.length).toBe(secret.length);
    expect(safeTokenCompare(attacker, secret)).toBe(false);
  });

  it('returns false for a prefix of the secret (length mismatch)', () => {
    expect(safeTokenCompare(secret.slice(0, 10), secret)).toBe(false);
  });

  it('returns false for an empty presented value', () => {
    expect(safeTokenCompare('', secret)).toBe(false);
  });

  it('returns false for non-string inputs (null, undefined, number, object)', () => {
    expect(safeTokenCompare(null, secret)).toBe(false);
    expect(safeTokenCompare(undefined, secret)).toBe(false);
    expect(safeTokenCompare(12345 as unknown, secret)).toBe(false);
    expect(safeTokenCompare({ token: secret } as unknown, secret)).toBe(false);
  });

  it('never throws — even on adversarial inputs', () => {
    // The whole point of this helper is that callers can use it inline in
    // a request gate without a try/catch. If any input could throw, that
    // contract is broken.
    expect(() => safeTokenCompare(null, '')).not.toThrow();
    expect(() => safeTokenCompare(undefined, undefined as unknown as string)).not.toThrow();
    expect(() => safeTokenCompare(Buffer.from('x') as unknown, 'x')).not.toThrow();
  });
});

describe('extractBearer', () => {
  it('extracts a token from a well-formed header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
    expect(extractBearer('bearer abc123')).toBe('abc123');
    expect(extractBearer('BEARER abc123')).toBe('abc123');
  });

  it('trims whitespace around the token', () => {
    expect(extractBearer('Bearer   abc123   ')).toBe('abc123');
  });

  it('returns null for a missing header', () => {
    expect(extractBearer(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer header', () => {
    expect(extractBearer('Basic abc123')).toBeNull();
    expect(extractBearer('abc123')).toBeNull();
  });
});
