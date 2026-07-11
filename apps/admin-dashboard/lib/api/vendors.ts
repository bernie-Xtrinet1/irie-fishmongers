import type { AssignableVendorStatus, Paginated, VendorAdmin, VendorStatus, VendorTier } from '@iriefishmongers/types';

import { apiGet, apiPatch } from '@/lib/api-client';

export interface ListVendorsParams {
  page: number;
  pageSize: number;
  status?: VendorStatus;
  tier?: VendorTier;
}

export async function fetchVendors(params: ListVendorsParams): Promise<Paginated<VendorAdmin>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.status) search.set('status', params.status);
  if (params.tier) search.set('tier', params.tier);

  return apiGet<Paginated<VendorAdmin>>(`/vendors?${search.toString()}`);
}

export async function updateVendorStatus(id: string, status: AssignableVendorStatus): Promise<VendorAdmin> {
  return apiPatch<VendorAdmin>(`/vendors/${id}/status`, { status });
}
