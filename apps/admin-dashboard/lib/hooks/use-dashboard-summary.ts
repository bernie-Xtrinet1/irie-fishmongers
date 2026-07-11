'use client';

import type { DashboardSummary } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchDashboardSummary } from '@/lib/api/analytics';

// One shared cache entry for every dashboard-summary consumer (KPI cards,
// the "Needs Attention" panel, the header's last-refreshed indicator).
// React Query dedupes concurrent/duplicate fetches for the SAME queryKey -
// six independent keys hitting the same URL would not get that for free,
// so every widget below must use this exact key and pick its own slice
// via `select` rather than defining its own key.
//
// System health is deliberately NOT part of this query - see
// use-health-status.ts. It polls a dedicated, cheap endpoint every 5s so a
// fast connectivity check never re-triggers this financial/order/vendor/
// driver/compliance aggregation.
export const DASHBOARD_SUMMARY_QUERY_KEY = ['analytics', 'dashboard-summary'] as const;
const REFETCH_INTERVAL_MS = 20_000;

export function useDashboardSummary<T = DashboardSummary>(
  select?: (data: DashboardSummary) => T,
): UseQueryResult<T> {
  return useQuery({
    queryKey: DASHBOARD_SUMMARY_QUERY_KEY,
    queryFn: () => fetchDashboardSummary(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    select,
  });
}
