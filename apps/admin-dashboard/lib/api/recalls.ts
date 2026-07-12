import type {
  AffectedOrder,
  ComplianceAuditLogEntry,
  Paginated,
  Recall,
  RecallSeverityClass,
  RecallStatus,
} from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

export interface ListRecallsParams {
  page: number;
  pageSize: number;
  status?: RecallStatus;
}

export async function fetchRecalls(params: ListRecallsParams): Promise<Paginated<Recall>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);

  return apiGet<Paginated<Recall>>(`/recalls?${search.toString()}`);
}

export interface CreateRecallInput {
  severityClass: RecallSeverityClass;
  reason: string;
  lotIds: string[];
}

export async function createRecall(input: CreateRecallInput): Promise<Recall> {
  return apiPost<Recall>('/recalls', input);
}

export interface UpdateRecallStatusInput {
  status: RecallStatus;
  rootCause?: string;
  resolutionNotes?: string;
}

export async function updateRecallStatus(id: string, input: UpdateRecallStatusInput): Promise<Recall> {
  return apiPatch<Recall>(`/recalls/${id}/status`, input);
}

export async function fetchAffectedOrders(recallId: string): Promise<AffectedOrder[]> {
  return apiGet<AffectedOrder[]>(`/recalls/${recallId}/affected-orders`);
}

export async function fetchRecallAuditLog(recallId: string): Promise<Paginated<ComplianceAuditLogEntry>> {
  const search = new URLSearchParams({ entityType: 'Recall', entityId: recallId, page: '1', pageSize: '20' });
  return apiGet<Paginated<ComplianceAuditLogEntry>>(`/food-safety/audit-logs?${search.toString()}`);
}
