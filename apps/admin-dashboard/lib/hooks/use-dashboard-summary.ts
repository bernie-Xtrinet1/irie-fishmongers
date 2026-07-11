'use client';

import type { DashboardSummary } from '@iriefishmongers/types';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchDashboardSummary } from '@/lib/api/analytics';

interface UseDashboardSummaryOptions {
  // Distinguishes each caller's query cache entry so every widget (and the
  // topbar's connectivity indicator) can have its own staleTime/
  // refetchInterval even though they all read the same endpoint.
  widget: string;
  staleTimeMs: number;
  refetchIntervalMs: number;
}

export function useDashboardSummary({
  widget,
  staleTimeMs,
  refetchIntervalMs,
}: UseDashboardSummaryOptions): UseQueryResult<DashboardSummary> {
  return useQuery({
    queryKey: ['dashboard-summary', widget],
    queryFn: () => fetchDashboardSummary(),
    staleTime: staleTimeMs,
    refetchInterval: refetchIntervalMs,
  });
}
