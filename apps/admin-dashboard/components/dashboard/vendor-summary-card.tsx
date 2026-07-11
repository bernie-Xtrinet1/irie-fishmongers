'use client';

import { memo } from 'react';

import { formatEnumLabel } from '@/lib/format';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { SummaryCard } from './summary-card';

function VendorSummaryCardImpl(): React.ReactElement {
  const query = useDashboardSummary((data) => data.vendors);

  return (
    <SummaryCard title="Vendors" query={query}>
      {(vendors) => (
        <dl className="flex flex-col gap-2 text-sm">
          {Object.entries(vendors.byStatus).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between">
              <dt className="text-gray-600">{formatEnumLabel(status)}</dt>
              <dd className="text-lg font-semibold text-gray-900">{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </SummaryCard>
  );
}

export const VendorSummaryCard = memo(VendorSummaryCardImpl);
