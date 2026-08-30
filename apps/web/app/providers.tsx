'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { AuthProvider } from '@/lib/auth/auth-context';

export function Providers({ children }: { children: React.ReactNode }): React.ReactElement {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider queryClient={queryClient}>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
