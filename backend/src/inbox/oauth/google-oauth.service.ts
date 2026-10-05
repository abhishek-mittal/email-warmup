import { Injectable, BadRequestException } from '@nestjs/common';
import { OAuthRefreshError, RefreshedToken } from './oauth-errors';
import { emailFromIdToken } from './id-token';

@Injectable()
export class GoogleOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    // Mailbox linking has its own callback, distinct from the account-login
    // callback that better-auth owns at /api/auth/callback/google.
    this.redirectUri =
      process.env.GOOGLE_MAILBOX_REDIRECT_URI ||
      `${process.env.APP_URL || 'http://localhost:3000'}/api/mailbox-oauth/callback/google`;
  }

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      // `openid email` makes the token response carry an ID token naming the
      // mailbox; the mail scope alone does not cover the userinfo endpoint.
      scope: 'openid email https://mail.google.com/',
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    /** The mailbox address, read from the ID token the provider returned with the tokens. */
    email: string;
  }> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new BadRequestException(
        data.error_description || data.error || 'Google token exchange failed',
      );
    }
    if (!data.refresh_token) {
      throw new BadRequestException('Refresh token missing. Re-authorize with prompt=consent.');
    }
    const email = emailFromIdToken(data.id_token);
    if (!email) {
      throw new BadRequestException('Provider did not return the mailbox address');
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      email,
    };
  }

  /**
   * Refreshes an access token. Defaults to the platform's own OAuth app
   * (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) — correct for inboxes connected
   * via the platform's interactive OAuth flow. A batch-imported pool inbox
   * supplies its OWN clientId/clientSecret (a different OAuth app entirely);
   * refresh tokens are bound to the client that issued them, so pass
   * `clientOverride` in that case.
   */
  async refreshToken(
    refreshToken: string,
    clientOverride?: { clientId: string; clientSecret: string },
  ): Promise<RefreshedToken> {
    const clientId = clientOverride?.clientId ?? this.clientId;
    const clientSecret = clientOverride?.clientSecret ?? this.clientSecret;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OAuthRefreshError(
        data.error_description || data.error || 'Google token refresh failed',
        data.error,
        response.status,
      );
    }
    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
    };
  }
}
