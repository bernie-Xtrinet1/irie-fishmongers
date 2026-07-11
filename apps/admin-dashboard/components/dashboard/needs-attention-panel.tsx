'use client';

import { AlertTriangle, Siren, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';

interface AttentionItem {
  href: string;
  icon: typeof AlertTriangle;
  label: string;
}

// Built entirely from fields the dashboard-summary endpoint already returns
// - no new backend surface. This is the actionable subset of a future
// notification inbox, not the inbox itself (12B+). Shares the same
// dashboard-summary query/cache entry as the KPI cards (see
// lib/hooks/use-dashboard-summary.ts) via `select`, rather than issuing
// its own separate request.
function NeedsAttentionPanelImpl(): React.ReactElement | null {
  const query = useDashboardSummary((data) => ({
    pendingVendors: data.vendors.byStatus.PENDING,
    activeRecalls: data.compliance.activeRecalls,
    urgentAlerts: data.compliance.activeAlertsBySeverity.CRITICAL + data.compliance.activeAlertsBySeverity.EMERGENCY,
  }));

  if (query.isPending || query.isError || !query.data) {
    return null;
  }

  const { pendingVendors, activeRecalls, urgentAlerts } = query.data;

  const items: AttentionItem[] = [
    pendingVendors > 0
      ? {
          href: '/vendors?status=PENDING',
          icon: UserCheck,
          label: `${pendingVendors} vendor application${pendingVendors === 1 ? '' : 's'} awaiting review`,
        }
      : null,
    activeRecalls > 0
      ? {
          href: '/recalls',
          icon: Siren,
          label: `${activeRecalls} active recall${activeRecalls === 1 ? '' : 's'}`,
        }
      : null,
    urgentAlerts > 0
      ? {
          href: '/cold-chain',
          icon: AlertTriangle,
          label: `${urgentAlerts} critical or emergency cold-chain alert${urgentAlerts === 1 ? '' : 's'}`,
        }
      : null,
  ].filter((item): item is AttentionItem => item !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs Attention</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing needs attention right now.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href + item.label}>
                  <Link
                    href={item.href}
                    className="flex min-h-11 items-center gap-3 rounded-button px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
                  >
                    <Icon className="h-5 w-5 flex-shrink-0 text-irie-red" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export const NeedsAttentionPanel = memo(NeedsAttentionPanelImpl);
