'use client';

import type { QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { isActiveAdminPortalUser, type RefreshedSessionUser } from '@/lib/auth/admin-access';
import { apiPost, configureApiClient } from '@/lib/api-client';

export type UserRole =
  | 'CUSTOMER'
  | 'VENDOR'
  | 'DRIVER'
  | 'OPERATIONS_STAFF'
  | 'ADMINISTRATOR';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status?: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  roles: UserRole[];
  canAuthorizeVendorSettlements?: boolean;
  canManageCataloguePhotos?: boolean;
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
// not to be an active administrator, and clears cached queries so no session
// data survives for an account the dashboard refuses to admit.
async function revokeCurrentSession(queryClient: QueryClient): Promise<void> {
  await apiPost('/auth/logout', {}).catch(() => undefined);
  queryClient.clear();
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

  const clearSessionAndCache = useCallback(() => {
    queryClient.clear();
    clearSession();
  }, [queryClient, clearSession]);

  useEffect(() => {
    configureApiClient({
      getAccessToken: () => accessTokenRef.current,
      onTokenRefreshed: (accessToken: string, refreshedUser?: RefreshedSessionUser) => {
        if (!isActiveAdminPortalUser(refreshedUser)) {
          clearSessionAndCache();
          router.replace('/login');
          return;
        }
        accessTokenRef.current = accessToken;
        if (refreshedUser?.id) {
          setUser((prev) => ({
            ...(prev ?? {}),
            id: refreshedUser.id,
            email: refreshedUser.email ?? prev?.email ?? '',
            firstName: refreshedUser.firstName ?? prev?.firstName ?? '',
            lastName: refreshedUser.lastName ?? prev?.lastName ?? '',
            status: refreshedUser.status ?? prev?.status,
            roles: refreshedUser.roles as UserRole[],
            canAuthorizeVendorSettlements:
              refreshedUser.canAuthorizeVendorSettlements ?? prev?.canAuthorizeVendorSettlements,
            canManageCataloguePhotos:
              refreshedUser.canManageCataloguePhotos ?? prev?.canManageCataloguePhotos,
          }));
        }
      },
      onUnauthorized: () => {
        clearSessionAndCache();
        router.replace('/login');
      },
    });
  }, [clearSessionAndCache, router]);

  useEffect(() => {
    let cancelled = false;

    async function silentRefresh(): Promise<void> {
      try {
        // Cookie carries the refresh token - no body needed. A page reload
        // re-establishes the session this way without ever having persisted
        // a token client-side.
        const session = await apiPost<AuthTokensResponse>('/auth/refresh', {});
        if (cancelled) return;

        if (!isActiveAdminPortalUser(session.user)) {
          accessTokenRef.current = null;
          setUser(null);
          await revokeCurrentSession(queryClient);
          if (!cancelled) setStatus('unauthenticated');
          return;
        }

        accessTokenRef.current = session.accessToken;
        setUser(session.user);
        setStatus('authenticated');
      } catch {
        if (!cancelled) {
          clearSessionAndCache();
        }
      }
    }

    void silentRefresh();
    return () => {
      cancelled = true;
    };
    // queryClient is stable for the lifetime of the app, so this still
    // behaves as a mount-time silent-refresh check while declaring the
    // dependency used by the non-admin session cleanup path.
  }, [clearSessionAndCache, queryClient]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const session = await apiPost<AuthTokensResponse>('/auth/login', { email, password });

      if (!isActiveAdminPortalUser(session.user)) {
        clearSession();
        await revokeCurrentSession(queryClient);
        throw new Error('This account does not have admin access.');
      }

      accessTokenRef.current = session.accessToken;
      setUser(session.user);
      setStatus('authenticated');
    },
    [clearSession, queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiPost('/auth/logout', {});
    } finally {
      // Cache must be cleared before another user can ever log in on the
      // same browser, so no stale admin data survives a session handoff.
      clearSessionAndCache();
      router.replace('/login');
    }
  }, [clearSessionAndCache, router]);

  return <AuthContext.Provider value={{ status, user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
