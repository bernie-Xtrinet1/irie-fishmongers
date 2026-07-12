'use client';

import type {
  AffectedOrder,
  ComplianceAuditLogEntry,
  Paginated,
  Recall,
} from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  createRecall,
  fetchAffectedOrders,
  fetchRecallAuditLog,
  fetchRecalls,
  updateRecallStatus,
  type CreateRecallInput,
  type ListRecallsParams,
  type UpdateRecallStatusInput,
} from '@/lib/api/recalls';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

const RECALLS_QUERY_KEY = 'recalls';

export function useRecalls(params: ListRecallsParams): UseQueryResult<Paginated<Recall>> {
  return useQuery({
    queryKey: [RECALLS_QUERY_KEY, params],
    queryFn: () => fetchRecalls(params),
  });
}

export function useCreateRecall(): ReturnType<typeof useMutation<Recall, Error, CreateRecallInput>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateRecallInput) => createRecall(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [RECALLS_QUERY_KEY] });
    },
  });
}

export function useUpdateRecallStatus(): ReturnType<
  typeof useMutation<Recall, Error, { id: string; input: UpdateRecallStatusInput }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRecallStatusInput }) => updateRecallStatus(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [RECALLS_QUERY_KEY] });
      // Activating a recall (DRAFT -> ACTIVE) quarantines its lots and
      // moves compliance.activeRecalls on the dashboard overview.
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}

export function useAffectedOrders(recallId: string | null): UseQueryResult<AffectedOrder[]> {
  return useQuery({
    queryKey: ['recall-affected-orders', recallId],
    queryFn: () => fetchAffectedOrders(recallId as string),
    enabled: recallId !== null,
  });
}

export function useRecallAuditLog(recallId: string | null): UseQueryResult<Paginated<ComplianceAuditLogEntry>> {
  return useQuery({
    queryKey: ['recall-audit-log', recallId],
    queryFn: () => fetchRecallAuditLog(recallId as string),
    enabled: recallId !== null,
  });
}
