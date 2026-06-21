import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class GoogleOAuthService {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    this.redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/callback/google`;
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'https://mail.google.com/',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
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
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new BadRequestException(data.error_description || data.error || 'Google token exchange failed');
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
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new BadRequestException(data.error_description || data.error || 'Google token refresh failed');
    }
    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
    };
  }
}
