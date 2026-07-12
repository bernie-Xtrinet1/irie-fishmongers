'use client';

import type { SalesAnalytics } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchSalesAnalytics } from '@/lib/api/analytics';

// Sales figures move with every new paid order - matches the dashboard's
// own Financial/Orders cadence (see use-dashboard-summary.ts) rather than
// the slower Vendor/Driver-summary cadence.
const REFETCH_INTERVAL_MS = 20_000;

export function useSalesAnalytics(): UseQueryResult<SalesAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'sales-analytics'],
    queryFn: () => fetchSalesAnalytics(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
