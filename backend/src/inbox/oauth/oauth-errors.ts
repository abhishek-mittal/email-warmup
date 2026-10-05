import { BadRequestException } from '@nestjs/common';

/**
 * A token refresh was rejected by the provider. `revoked` is true only for
 * responses that mean the grant itself is gone (user removed access, password
 * reset, token expired from disuse) — retrying those can never succeed and the
 * mailbox must be reconnected. Everything else is treated as temporary.
 *
 * Extends BadRequestException so existing callers/tests that match on the
 * provider's error message keep working.
 */
export class OAuthRefreshError extends BadRequestException {
  readonly revoked: boolean;

  constructor(
    message: string,
    readonly oauthError: string | undefined,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.revoked = oauthError === 'invalid_grant';
  }
}

/** The mailbox's grant is gone; the owner must reconnect it. */
export class CredentialRevokedError extends Error {
  constructor(readonly ownerId: string) {
    super(`Mailbox credentials revoked for ${ownerId}; reconnect required`);
    this.name = 'CredentialRevokedError';
  }
}

export interface RefreshedToken {
  access_token: string;
  expires_in: number;
  /** Present when the provider rotated the refresh token (Microsoft does). */
  refresh_token?: string;
}
