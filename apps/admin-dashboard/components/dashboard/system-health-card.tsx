'use client';

import { memo } from 'react';

import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { cn } from '@/lib/utils';
import { SummaryCard } from './summary-card';

function StatusRow({ label, status }: { label: string; status: 'up' | 'down' }): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-700">{label}</span>
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <span
          className={cn('h-2.5 w-2.5 rounded-full', status === 'up' ? 'bg-irie-green' : 'bg-irie-red')}
          aria-hidden="true"
        />
        <span className={status === 'up' ? 'text-irie-green' : 'text-irie-red'}>
          {status === 'up' ? 'Operational' : 'Down'}
        </span>
      </span>
    </div>
  );
}

function SystemHealthCardImpl(): React.ReactElement {
  const query = useDashboardSummary({ widget: 'system-health-detail', staleTimeMs: 5_000, refetchIntervalMs: 5_000 });

  return (
    <SummaryCard title="System Health" query={query}>
      {(data) => (
        <div className="flex flex-col gap-3">
          <StatusRow label="Database (PostgreSQL)" status={data.systemHealth.postgres} />
          <StatusRow label="Cache (Redis)" status={data.systemHealth.redis} />
        </div>
      )}
    </SummaryCard>
  );
}

export const SystemHealthCard = memo(SystemHealthCardImpl);
