'use client';

import type { DeliveryAnalytics } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchDeliveryAnalytics } from '@/lib/api/analytics';

// SLA breaches and fleet status can change quickly during active delivery
// windows - matches the dashboard's Compliance cadence (see
// use-dashboard-summary.ts) rather than the slower Vendor/Driver cadence.
const REFETCH_INTERVAL_MS = 10_000;

export function useDeliveryAnalytics(): UseQueryResult<DeliveryAnalytics> {
  return useQuery({
    queryKey: ['analytics', 'delivery-analytics'],
    queryFn: () => fetchDeliveryAnalytics(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
