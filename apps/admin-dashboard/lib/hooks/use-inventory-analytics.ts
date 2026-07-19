'use client';

import type { InventoryAnalytics } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchInventoryAnalytics } from '@/lib/api/analytics';

// Stock levels don't change as fast as live delivery/sales data - matches
// the dashboard's Vendor/Driver-summary cadence (see use-dashboard-summary.ts).
const REFETCH_INTERVAL_MS = 30_000;

export function useInventoryAnalytics(): UseQueryResult<InventoryAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'inventory-analytics'],
    queryFn: () => fetchInventoryAnalytics(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
