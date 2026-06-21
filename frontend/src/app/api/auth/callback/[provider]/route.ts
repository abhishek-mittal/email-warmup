import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/**
 * OAuth callback handler. The provider (Google / Microsoft) redirects the
 * browser here with `?code=...&state=...`. We forward the code to the backend
 * (which holds the OAuth client secret) and then redirect the user to
 * `/inboxes`.
 *
 * Route is marked public in middleware so the unauthenticated bounce from
 * Google works.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/inboxes?oauth_error=${encodeURIComponent(error)}`, req.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/inboxes?oauth_error=missing_code', req.url));
  }

  // Backend endpoint: /auth/callback/google or /auth/callback/microsoft.
  // The provider from the URL param is "google" or "microsoft" — backend uses
  // the same names. We POST the code to the backend with the Clerk JWT in
  // the Authorization header.
  const { getToken } = await auth();
  const token = await getToken();

  const backendUrl =
    provider === 'google'
      ? `${API_URL}/auth/callback/google`
      : provider === 'microsoft'
      ? `${API_URL}/auth/callback/microsoft`
      : null;

  if (!backendUrl) {
    return NextResponse.redirect(new URL('/inboxes?oauth_error=unknown_provider', req.url));
  }

  try {
    const res = await fetch(backendUrl, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      return NextResponse.redirect(
        new URL(`/inboxes?oauth_error=backend_${res.status}`, req.url),
      );
    }
  } catch {
    return NextResponse.redirect(
      new URL(`/inboxes?oauth_error=network`, req.url),
    );
  }

  return NextResponse.redirect(new URL('/inboxes?connected=1', req.url));
}
