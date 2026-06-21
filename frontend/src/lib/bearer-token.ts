/**
 * Mint a signed bearer token for the backend. Token format:
 *   v1.<base64url(userId)>.<base64url(expiryMs)>.<base64url(hmac)>
 *
 * The HMAC is computed over the first three parts using BETTER_AUTH_SECRET
 * shared with the backend. This lets the NestJS API verify the token without
 * a DB lookup and without a JWT library on either side.
 */
export async function mintBearerToken(
  userId: string,
  secret: string,
  ttlMs: number = 60 * 60 * 1000, // 1h
): Promise<string> {
  const expiry = Date.now() + ttlMs;
  const userPart = b64u(userId);
  const expPart = b64u(String(expiry));
  const payload = `v1.${userPart}.${expPart}`;
  const sig = await hmac(payload, secret); // already base64url
  return `${payload}.${sig}`;
}

async function hmac(message: string, secret: string): Promise<string> {
  // Web Crypto API (works in both browser and Node 18+). We need the raw
  // HMAC bytes as base64url, not a UTF-8 decoding of those bytes. The
  // caller's `b64u()` will base64url-encode whatever we return, so
  // returning a TextDecoder-decoded string would corrupt the signature
  // with replacement characters (U+FFFD) wherever the raw byte is not
  // valid UTF-8. The backend verifies the same payload against the
  // base64url-encoded raw bytes via `timingSafeEqual`.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToBase64Url(new Uint8Array(buf));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64url');
  }
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64u(input: string): string {
  // btoa works for ASCII. For arbitrary bytes from hmac, we use a manual encoder.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64url');
  }
  // Browser: convert string -> utf8 bytes -> base64url
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}