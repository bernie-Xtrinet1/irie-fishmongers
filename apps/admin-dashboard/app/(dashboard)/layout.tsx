import { DashboardShell } from '@/components/dashboard-shell';
import { RequireAdmin } from '@/components/require-admin';

export default function DashboardLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <RequireAdmin>
      <DashboardShell>{children}</DashboardShell>
    </RequireAdmin>
  );
}
