import type {
  AssignableDriverStatus,
  DriverAdmin,
  DriverPerformanceMetrics,
  DriverStatus,
  Paginated,
} from '@iriefishmongers/types';

import { apiGet, apiPatch } from '@/lib/api-client';

export interface ListDriversParams {
  page: number;
  pageSize: number;
  status?: DriverStatus;
}

export async function fetchDrivers(params: ListDriversParams): Promise<Paginated<DriverAdmin>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);

  return apiGet<Paginated<DriverAdmin>>(`/drivers?${search.toString()}`);
}

export async function updateDriverStatus(id: string, status: AssignableDriverStatus): Promise<DriverAdmin> {
  return apiPatch<DriverAdmin>(`/drivers/${id}/status`, { status });
}

export async function fetchDriverPerformance(id: string): Promise<DriverPerformanceMetrics> {
  return apiGet<DriverPerformanceMetrics>(`/drivers/${id}/performance`);
}
