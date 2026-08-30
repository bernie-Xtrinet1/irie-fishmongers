'use client';

import type { QueryClient } from '@tanstack/react-query';
import type { AuthTokensResponse, AuthUser } from '@iriefishmongers/types';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { apiPost, configureApiClient } from '@/lib/api-client';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  // The access token is intentionally memory-only. The refresh token remains
  // in the backend-issued httpOnly cookie and is never persisted by the Web
  // application in localStorage or sessionStorage.
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
        queryClient.clear();
        clearSession();
      },
    });
  }, [clearSession, queryClient]);

  useEffect(() => {
    let cancelled = false;

    async function silentRefresh(): Promise<void> {
      try {
        const session = await apiPost<AuthTokensResponse>('/auth/refresh', {});

        if (cancelled) return;

        accessTokenRef.current = session.accessToken;
        setUser(session.user);
        setStatus('authenticated');
      } catch {
        if (!cancelled) {
          accessTokenRef.current = null;
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    }

    void silentRefresh();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const session = await apiPost<AuthTokensResponse>('/auth/login', {
        email,
        password,
      });

      // A different account may be signing in on the same browser. Clear all
      // server-state cached for the previous identity before exposing the new
      // authenticated session.
      queryClient.clear();

      accessTokenRef.current = session.accessToken;
      setUser(session.user);
      setStatus('authenticated');
    },
    [queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiPost('/auth/logout', {});
    } finally {
      queryClient.clear();
      clearSession();
    }
  }, [clearSession, queryClient]);

  return (
    <AuthContext.Provider value={{ status, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}
