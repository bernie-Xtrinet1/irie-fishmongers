'use client';

import { memo } from 'react';

import { useHealthStatus } from '@/lib/hooks/use-health-status';
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

// Deliberately independent from the other five overview cards - it reads
// GET /health/status (lib/hooks/use-health-status.ts) rather than the
// shared dashboard-summary query, so this card's 5s poll never re-runs the
// financial/order/vendor/driver/compliance aggregation, and a
// dashboard-summary failure never takes this one down with it.
function SystemHealthCardImpl(): React.ReactElement {
  const query = useHealthStatus();

  return (
    <SummaryCard title="System Health" query={query}>
      {(data) => (
        <div className="flex flex-col gap-3">
          <StatusRow label="Database (PostgreSQL)" status={data.postgres} />
          <StatusRow label="Cache (Redis)" status={data.redis} />
        </div>
      )}
    </SummaryCard>
  );
}

export const SystemHealthCard = memo(SystemHealthCardImpl);
