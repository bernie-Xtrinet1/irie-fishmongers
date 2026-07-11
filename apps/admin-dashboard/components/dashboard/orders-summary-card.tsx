'use client';

import { memo } from 'react';

import { formatEnumLabel } from '@/lib/format';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { SummaryCard } from './summary-card';

function OrdersSummaryCardImpl(): React.ReactElement {
  const query = useDashboardSummary({ widget: 'orders', staleTimeMs: 15_000, refetchIntervalMs: 15_000 });

  return (
    <SummaryCard title="Orders" query={query}>
      {(data) => (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Customer orders</p>
            <p className="text-2xl font-semibold text-gray-900">{data.orders.customerOrdersTotal}</p>
          </div>
          <div>
            {/* Distinct from customerOrdersTotal above - a customer order
                split across vendors counts once per vendor leg here. */}
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Vendor order legs by status</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {Object.entries(data.orders.vendorOrdersByStatus).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between gap-2">
                  <dt className="text-gray-600">{formatEnumLabel(status)}</dt>
                  <dd className="font-medium text-gray-900">{count}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </SummaryCard>
  );
}

export const OrdersSummaryCard = memo(OrdersSummaryCardImpl);
