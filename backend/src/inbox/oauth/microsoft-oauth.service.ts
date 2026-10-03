import { Injectable, BadRequestException } from '@nestjs/common';
import { OAuthRefreshError, RefreshedToken } from './oauth-errors';
import { emailFromIdToken } from './id-token';

@Injectable()
export class MicrosoftOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.MICROSOFT_CLIENT_ID || '';
    this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
    // Mailbox linking has its own callback, distinct from the account-login
    // callback that better-auth owns at /api/auth/callback/microsoft.
    this.redirectUri =
      process.env.MICROSOFT_MAILBOX_REDIRECT_URI ||
      `${process.env.APP_URL || 'http://localhost:3000'}/api/mailbox-oauth/callback/microsoft`;
  }

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope:
        // `openid email` yields an ID token naming the mailbox. Graph's /me can't
        // be used: these tokens are issued for outlook.office.com, not Graph.
        'openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
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
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
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
        data.error_description || data.error || 'Microsoft token exchange failed',
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
   * (MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET) — correct for inboxes
   * connected via the platform's interactive OAuth flow. A batch-imported
   * pool inbox supplies its OWN clientId/clientSecret (a different OAuth app
   * entirely); refresh tokens are bound to the client that issued them, so
   * pass `clientOverride` in that case.
   */
  async refreshToken(
    refreshToken: string,
    clientOverride?: { clientId: string; clientSecret: string },
  ): Promise<RefreshedToken> {
    const clientId = clientOverride?.clientId ?? this.clientId;
    const clientSecret = clientOverride?.clientSecret ?? this.clientSecret;

    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        scope:
          'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OAuthRefreshError(
        data.error_description || data.error || 'Microsoft token refresh failed',
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
