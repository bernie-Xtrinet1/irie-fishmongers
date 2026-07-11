'use client';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';

// Placeholder overview - replaced by the modular widget dashboard
// (FinancialSummaryCard/OrdersSummaryCard/etc.) in a later task.
export default function DashboardOverviewPage(): React.ReactElement {
  const { user, logout } = useAuth();

  return (
    <main className="flex min-h-screen flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold text-gray-900">
        Welcome, {user?.firstName} {user?.lastName}
      </h1>
      <p className="text-sm text-gray-500">Signed in as {user?.email}.</p>
      <Button variant="secondary" className="w-fit" onClick={() => void logout()}>
        Log out
      </Button>
    </main>
  );
}
