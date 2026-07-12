import type {
  DeliveryExceptionWithContext,
  DeliveryRun,
  DeliveryRunStatus,
  Paginated,
} from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

export interface ListDeliveryRunsParams {
  page: number;
  pageSize: number;
  status?: DeliveryRunStatus;
  zoneId?: string;
}

export async function fetchDeliveryRuns(
  params: ListDeliveryRunsParams,
): Promise<Paginated<DeliveryRun>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);
  if (params.zoneId) search.set('zoneId', params.zoneId);

  return apiGet<Paginated<DeliveryRun>>(`/delivery-runs?${search.toString()}`);
}

export async function dispatchDeliveryRun(id: string): Promise<DeliveryRun> {
  return apiPost<DeliveryRun>(`/delivery-runs/${id}/dispatch`, {});
}

export interface ListDeliveryExceptionsParams {
  page: number;
  pageSize: number;
  resolved?: boolean;
}

export async function fetchDeliveryExceptions(
  params: ListDeliveryExceptionsParams,
): Promise<Paginated<DeliveryExceptionWithContext>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.resolved !== undefined) search.set('resolved', String(params.resolved));

  return apiGet<Paginated<DeliveryExceptionWithContext>>(`/delivery/exceptions?${search.toString()}`);
}

export async function resolveDeliveryException(id: string): Promise<DeliveryExceptionWithContext> {
  return apiPatch<DeliveryExceptionWithContext>(`/delivery/exceptions/${id}/resolve`, {});
}
