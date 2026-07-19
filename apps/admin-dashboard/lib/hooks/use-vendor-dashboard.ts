'use client';

import type { VendorDashboard } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchVendorDashboard } from '@/lib/api/analytics';

// Vendor status/tier approvals are not high-frequency - matches the
// Vendor/Driver summary cadence on the Dashboard Overview (see
// use-dashboard-summary.ts).
const REFETCH_INTERVAL_MS = 30_000;

export function useVendorDashboard(): UseQueryResult<VendorDashboard> {
  return useQuery({
    queryKey: ['analytics', 'vendor-dashboard'],
    queryFn: () => fetchVendorDashboard(),
    staleTime: REFETCH_INTERVAL_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}
