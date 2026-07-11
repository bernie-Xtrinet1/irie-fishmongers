'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth/auth-context';

// UX-only route protection (ADR-004) - the real authorization boundary is
// every admin backend endpoint's independent RolesGuard(ADMINISTRATOR)
// check. This wrapper only prevents a flash of protected UI before the
// silent-refresh session check resolves.
export function RequireAdmin({ children }: { children: React.ReactNode }): React.ReactElement {
  const router = useRouter();
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
