import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class MicrosoftOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.MICROSOFT_CLIENT_ID || '';
    this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
    this.redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/callback/microsoft`;
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
      prompt: 'consent',
      state,
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
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
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new BadRequestException(data.error_description || data.error || 'Microsoft token exchange failed');
    }
    if (!data.refresh_token) {
      throw new BadRequestException('Refresh token missing. Re-authorize with prompt=consent.');
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
  }

  async refreshToken(refreshToken: string): Promise<{
    access_token: string;
    expires_in: number;
  }> {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new BadRequestException(data.error_description || data.error || 'Microsoft token refresh failed');
    }
    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
    };
  }
}
