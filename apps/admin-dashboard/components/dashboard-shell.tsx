'use client';

import {
  AlertTriangle,
  BarChart3,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Route,
  Store,
  Thermometer,
  TrendingUp,
  Truck,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { env } from '@/lib/env';
import { useHealthStatus } from '@/lib/hooks/use-health-status';
import { cn } from '@/lib/utils';

// The 6 screens shipped in Phase 12A plus Delivery Operations Center
// (Phase 10B) and Vendor Dashboard / Sales Analytics (Phase 12B) - no
// placeholder links implying a more-complete admin experience than what's
// actually shipped (12C covers Compliance Administration/Reporting; the
// remaining Phase 12B deliverables - Delivery/Inventory Analytics - are
// tracked but not yet built).
const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/vendors', label: 'Vendors', icon: Store },
  { href: '/vendor-dashboard', label: 'Vendor Dashboard', icon: BarChart3 },
  { href: '/sales-analytics', label: 'Sales Analytics', icon: TrendingUp },
  { href: '/drivers', label: 'Drivers', icon: Truck },
  { href: '/delivery-zones', label: 'Delivery Zones & Fleet', icon: MapPinned },
  { href: '/delivery-operations', label: 'Delivery Operations', icon: Route },
  { href: '/cold-chain', label: 'Cold Chain', icon: Thermometer },
  { href: '/recalls', label: 'Recalls', icon: AlertTriangle },
];

export function DashboardShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const health = useHealthStatus();

  const isHealthy = health.data?.postgres === 'up' && health.data?.redis === 'up';

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="flex h-16 items-center gap-2 border-b border-gray-200 px-6">
          <span className="text-lg font-semibold text-irie-green">Irie Fishmongers</span>
        </div>
        <nav aria-label="Admin navigation" className="flex flex-1 flex-col gap-1 p-3">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-button px-4 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2',
                  isActive ? 'bg-irie-green/10 text-irie-green' : 'text-gray-700 hover:bg-gray-100',
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        {env.environment !== 'production' ? (
          <div className="bg-irie-yellow px-4 py-1 text-center text-xs font-semibold uppercase tracking-wide text-gray-900">
            {env.environment} environment - not production data
          </div>
        ) : null}

        <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6">
          <div className="flex items-center gap-3">
            <Badge variant="neutral">API v1</Badge>
            <span
              className="flex items-center gap-1.5 text-sm"
              role="status"
              aria-label={`Backend connectivity: ${isHealthy ? 'operational' : 'degraded'}`}
            >
              <span
                className={cn('h-2.5 w-2.5 rounded-full', isHealthy ? 'bg-irie-green' : 'bg-irie-red')}
                aria-hidden="true"
              />
              <span className={isHealthy ? 'text-gray-600' : 'text-irie-red'}>
                {health.isPending ? 'Checking systems…' : isHealthy ? 'All systems operational' : 'Service issue'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right text-sm">
              <p className="font-medium text-gray-900">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-gray-500">Administrator</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Log out
            </Button>
          </div>
        </header>

        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
