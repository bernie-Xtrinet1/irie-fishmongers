'use client';

import { memo } from 'react';

import { formatCurrency } from '@/lib/format';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { SummaryCard } from './summary-card';

function FinancialSummaryCardImpl(): React.ReactElement {
  const query = useDashboardSummary((data) => data.financials);

  return (
    <SummaryCard title="Financials" query={query}>
      {(financials) => (
        <dl className="flex flex-col gap-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Gross paid volume</dt>
            <dd className="text-2xl font-semibold text-gray-900">
              {formatCurrency(financials.grossPaidAmount, financials.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Platform commission</dt>
            <dd className="text-xl font-semibold text-irie-green">
              {formatCurrency(financials.platformCommission, financials.currency)}
            </dd>
          </div>
        </dl>
      )}
    </SummaryCard>
  );
}

export const FinancialSummaryCard = memo(FinancialSummaryCardImpl);
