import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Edge middleware: redirect unauthenticated requests for protected routes
 * to /sign-in. We check the better-auth session cookie directly (it is
 * readable in Edge runtime via `getSessionCookie`); full token verification
 * happens inside Server Components / Route Handlers via the auth instance.
 */
const isPublicRoute = (path: string) =>
  path === '/' ||
  path.startsWith('/sign-in') ||
  path.startsWith('/sign-up') ||
  path.startsWith('/forgot-password') ||
  path.startsWith('/invite') ||
  path.startsWith('/reset-password') ||
  path.startsWith('/api/auth') ||
  // These validate the session themselves and answer with a proper 401 /
  // redirect; a cookie-presence check here would turn API calls into HTML redirects.
  path.startsWith('/api/backend') ||
  path.startsWith('/api/mailbox-oauth') ||
  path.startsWith('/api/webhooks');

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicRoute(pathname)) return NextResponse.next();

  const sessionCookie = getSessionCookie(req);
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('redirect_url', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};