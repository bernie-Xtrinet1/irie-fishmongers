'use client';

import { ComplianceSummaryCard } from '@/components/dashboard/compliance-summary-card';
import { DashboardGrid } from '@/components/dashboard/dashboard-grid';
import { NeedsAttentionPanel } from '@/components/dashboard/needs-attention-panel';
import { SystemHealthCard } from '@/components/dashboard/system-health-card';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';

export default function DashboardOverviewPage(): React.ReactElement {
  // Drives only the "last refreshed" header indicator - each widget below
  // still runs its own independent query at its own cadence.
  const headerQuery = useDashboardSummary({ widget: 'header', staleTimeMs: 15_000, refetchIntervalMs: 15_000 });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500" role="status">
          {headerQuery.dataUpdatedAt
            ? `Last refreshed ${new Date(headerQuery.dataUpdatedAt).toLocaleTimeString('en-JM')}`
            : 'Loading…'}
        </p>
      </div>

      <DashboardGrid />

      <NeedsAttentionPanel />

      <ComplianceSummaryCard />

      <SystemHealthCard />
    </div>
  );
}
