'use client';

import type { DashboardSystemHealth } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchHealthStatus } from '@/lib/api/health';

// Independent from the dashboard-summary query (use-dashboard-summary.ts)
// - a 5s connectivity poll must never re-trigger the full financial/order/
// vendor/driver/compliance aggregation, so this hits its own cheap
// endpoint under its own queryKey.
export const HEALTH_STATUS_QUERY_KEY = ['health-status'] as const;
const REFETCH_INTERVAL_MS = 5_000;

export function useHealthStatus(): UseQueryResult<DashboardSystemHealth> {
  return useQuery({
    queryKey: HEALTH_STATUS_QUERY_KEY,
    queryFn: () => fetchHealthStatus(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
