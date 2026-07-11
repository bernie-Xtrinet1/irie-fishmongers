import type { DashboardSummary } from '@iriefishmongers/types';

import { apiGet } from '@/lib/api-client';

export interface DashboardSummaryRange {
  from?: string;
  to?: string;
}

export async function fetchDashboardSummary(range?: DashboardSummaryRange): Promise<DashboardSummary> {
  if (!range?.from && !range?.to) {
    return apiGet<DashboardSummary>('/analytics/dashboard-summary');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<DashboardSummary>(`/analytics/dashboard-summary?${params.toString()}`);
}
