import { RequireAdmin } from '@/components/require-admin';

// Placeholder shell - the real sidebar/topbar (name/role, logout, system
// health indicator, API version badge, environment banner) is built in a
// later task. This exists now only so the auth flow (RequireAdmin, login,
// silent refresh) can be verified end-to-end before the shell is built on
// top of it.
export default function DashboardLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return <RequireAdmin>{children}</RequireAdmin>;
}
