'use client';

import { memo } from 'react';

import { formatEnumLabel } from '@/lib/format';
import { useDashboardSummary } from '@/lib/hooks/use-dashboard-summary';
import { SummaryCard } from './summary-card';

function ComplianceSummaryCardImpl(): React.ReactElement {
  const query = useDashboardSummary((data) => data.compliance);

  return (
    <SummaryCard title="Compliance" query={query}>
      {(compliance) => (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Active recalls</p>
            <p className="text-2xl font-semibold text-gray-900">{compliance.activeRecalls}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Active alerts by severity</p>
            <dl className="mt-2 flex flex-col gap-1 text-sm">
              {Object.entries(compliance.activeAlertsBySeverity).map(([severity, count]) => (
                <div key={severity} className="flex items-center justify-between">
                  <dt className="text-gray-600">{formatEnumLabel(severity)}</dt>
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

export const ComplianceSummaryCard = memo(ComplianceSummaryCardImpl);
