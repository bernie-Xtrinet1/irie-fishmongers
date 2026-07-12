'use client';

import type { AssignableDriverStatus, DriverAdmin, DriverPerformanceMetrics, Paginated } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { fetchDriverPerformance, fetchDrivers, updateDriverStatus, type ListDriversParams } from '@/lib/api/drivers';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

export function useDrivers(params: ListDriversParams): UseQueryResult<Paginated<DriverAdmin>> {
  return useQuery({
    queryKey: ['drivers', params],
    queryFn: () => fetchDrivers(params),
  });
}

export function useDriverPerformance(id: string | null): UseQueryResult<DriverPerformanceMetrics> {
  return useQuery({
    queryKey: ['drivers', id, 'performance'],
    queryFn: () => fetchDriverPerformance(id as string),
    enabled: id !== null,
  });
}

export function useUpdateDriverStatus(): ReturnType<
  typeof useMutation<DriverAdmin, Error, { id: string; status: AssignableDriverStatus }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AssignableDriverStatus }) => updateDriverStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      // A driver status change moves the drivers.byStatus dashboard KPI.
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}
