'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { isActiveAdminUser } from '@/lib/auth/admin-access';
import { useAuth } from '@/lib/auth/auth-context';

// UX-only route protection (ADR-004) - the real authorization boundary is
// every admin backend endpoint's independent RolesGuard(ADMINISTRATOR)
// check. This wrapper prevents protected UI or queries from rendering unless
// the signed-in user currently holds an active ADMINISTRATOR role.
export function RequireAdmin({ children }: { children: React.ReactNode }): React.ReactElement {
  const router = useRouter();
  const { status, user, logout } = useAuth();
  const hasAdminAccess = status === 'authenticated' && isActiveAdminUser(user);

  useEffect(() => {
    if (status === 'authenticated' && !hasAdminAccess) {
      void logout();
      return;
    }
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, hasAdminAccess, logout, router]);

  if (!hasAdminAccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
