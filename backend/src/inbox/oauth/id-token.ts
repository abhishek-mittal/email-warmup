/**
 * Reads the mailbox address from an OIDC ID token.
 *
 * The token is taken straight from the provider's token endpoint over TLS in
 * exchange for an authorization code, so per OpenID Connect Core 3.1.3.7 the
 * TLS server validation stands in for checking the token's signature. Never
 * use this on an ID token that arrived any other way (e.g. from a browser).
 */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      email?: unknown;
      email_verified?: unknown;
      preferred_username?: unknown;
    };
    // Google states verification explicitly; refuse an address it marks unverified.
    if (claims.email_verified === false) return null;
    const candidate =
      typeof claims.email === 'string'
        ? claims.email
        : typeof claims.preferred_username === 'string'
          ? claims.preferred_username
          : null;
    if (!candidate || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate)) return null;
    return candidate.toLowerCase();
  } catch {
    return null;
  }
}
