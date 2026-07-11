'use client';

import type { QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { apiPost, configureApiClient } from '@/lib/api-client';

export type UserRole = 'CUSTOMER' | 'VENDOR' | 'DRIVER' | 'ADMINISTRATOR';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: UserRole[];
}

interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Revokes a just-issued refresh token when the signed-in account turns out
// not to be an administrator, so this dashboard never leaves a live session
// behind for an account it refuses to admit.
async function revokeCurrentSession(): Promise<void> {
  await apiPost('/auth/logout', {}).catch(() => undefined);
}

export function AuthProvider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}): React.ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  // Access token lives in memory only (ADR-004) - never in localStorage/
  // sessionStorage. A ref (not state) so api-client's getAccessToken always
  // reads the current value without re-subscribing.
  const accessTokenRef = useRef<string | null>(null);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    configureApiClient({
      getAccessToken: () => accessTokenRef.current,
      onTokenRefreshed: (accessToken) => {
        accessTokenRef.current = accessToken;
      },
      onUnauthorized: () => {
        clearSession();
        router.replace('/login');
      },
    });
  }, [clearSession, router]);

  useEffect(() => {
    let cancelled = false;

    async function silentRefresh(): Promise<void> {
      try {
        // Cookie carries the refresh token - no body needed. A page reload
        // re-establishes the session this way without ever having persisted
        // a token client-side.
        const session = await apiPost<AuthTokensResponse>('/auth/refresh', {});
        if (cancelled) return;

        if (!session.user.roles.includes('ADMINISTRATOR')) {
          await revokeCurrentSession();
          if (!cancelled) setStatus('unauthenticated');
          return;
        }

        accessTokenRef.current = session.accessToken;
        setUser(session.user);
        setStatus('authenticated');
      } catch {
        if (!cancelled) setStatus('unauthenticated');
      }
    }

    void silentRefresh();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only - this is the silent-refresh
    // check, not a subscription to reactive dependencies.
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const session = await apiPost<AuthTokensResponse>('/auth/login', { email, password });

    if (!session.user.roles.includes('ADMINISTRATOR')) {
      await revokeCurrentSession();
      throw new Error('This account does not have admin access.');
    }

    accessTokenRef.current = session.accessToken;
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiPost('/auth/logout', {});
    } finally {
      // Cache must be cleared before another user can ever log in on the
      // same browser, so no stale admin data survives a session handoff.
      queryClient.clear();
      clearSession();
      router.replace('/login');
    }
  }, [queryClient, clearSession, router]);

  return <AuthContext.Provider value={{ status, user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
