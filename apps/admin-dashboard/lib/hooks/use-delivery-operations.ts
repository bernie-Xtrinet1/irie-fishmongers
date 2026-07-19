'use client';

import { DeliveryRunStatus, type DeliveryExceptionWithContext, type DeliveryRun, type Paginated } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  dispatchDeliveryRun,
  fetchDeliveryExceptions,
  fetchDeliveryRuns,
  resolveDeliveryException,
  type ListDeliveryExceptionsParams,
  type ListDeliveryRunsParams,
} from '@/lib/api/delivery-operations';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

// Polling, not WebSockets - same call as 12A's dashboard widgets (see
// use-dashboard-summary.ts): React Query refetchInterval is "live enough"
// for an operator screen and needs no new backend infrastructure. PLANNED
// runs and open exceptions poll faster (15s) since they're the two lists a
// dispatcher acts on; IN_PROGRESS runs are informational and poll slower
// (30s), matching the dashboard's own vendor/driver-summary cadence.
const DISPATCH_QUEUE_REFETCH_INTERVAL_MS = 15_000;
const ACTIVE_RUNS_REFETCH_INTERVAL_MS = 30_000;
const EXCEPTIONS_REFETCH_INTERVAL_MS = 15_000;

export function useDeliveryRuns(params: ListDeliveryRunsParams): UseQueryResult<Paginated<DeliveryRun>> {
  return useQuery({
    queryKey: ['delivery-runs', params],
    queryFn: () => fetchDeliveryRuns(params),
    refetchInterval:
      params.status === DeliveryRunStatus.IN_PROGRESS
        ? ACTIVE_RUNS_REFETCH_INTERVAL_MS
        : DISPATCH_QUEUE_REFETCH_INTERVAL_MS,
  });
}

export function useDispatchDeliveryRun(): ReturnType<typeof useMutation<DeliveryRun, Error, string>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => dispatchDeliveryRun(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['delivery-runs'] });
    },
  });
}

export function useDeliveryExceptions(
  params: ListDeliveryExceptionsParams,
): UseQueryResult<Paginated<DeliveryExceptionWithContext>> {
  return useQuery({
    queryKey: ['delivery-exceptions', params],
    queryFn: () => fetchDeliveryExceptions(params),
    refetchInterval: EXCEPTIONS_REFETCH_INTERVAL_MS,
  });
}

export function useResolveDeliveryException(): ReturnType<
  typeof useMutation<DeliveryExceptionWithContext, Error, string>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => resolveDeliveryException(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['delivery-exceptions'] });
      // A resolved exception can move the Compliance/Delivery "Needs
      // Attention" picture on the dashboard overview.
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}
