'use client';

import { createAuthClient } from 'better-auth/react';
import { genericOAuthClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL:
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'),
  // Enables signIn.oauth2({ providerId: 'citadel' }) for Citadel SSO.
  plugins: [genericOAuthClient()],
});

export const useSession = authClient.useSession;
export const signIn = authClient.signIn;
export const signOut = authClient.signOut;
export const signUp = authClient.signUp;