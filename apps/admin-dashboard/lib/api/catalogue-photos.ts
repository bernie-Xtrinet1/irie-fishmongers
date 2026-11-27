import type {
  AdminCataloguePhotoHistoryResponse,
  AdminCataloguePhotoItem,
  AdminCataloguePhotoListResponse,
} from '@iriefishmongers/types';

import { apiFetchBlob, apiGet, apiPatchForm, apiPost, apiPostForm } from '@/lib/api-client';

export interface ListAdminCataloguePhotosParams {
  speciesId?: string;
  search?: string;
  status?: 'ALL' | 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETIRED';
}

export async function fetchAdminCataloguePhotos(
  params?: ListAdminCataloguePhotosParams,
): Promise<AdminCataloguePhotoListResponse> {
  const qs = new URLSearchParams();
  if (params?.speciesId) qs.set('speciesId', params.speciesId);
  if (params?.search?.trim()) qs.set('search', params.search.trim());
  if (params?.status && params.status !== 'ALL') qs.set('status', params.status);
  const suffix = qs.toString();
  return apiGet<AdminCataloguePhotoListResponse>(
    suffix ? `/admin/catalogue-photos?${suffix}` : '/admin/catalogue-photos',
  );
}

export async function fetchAdminCataloguePhotoHistory(
  id: string,
): Promise<AdminCataloguePhotoHistoryResponse> {
  return apiGet<AdminCataloguePhotoHistoryResponse>(`/admin/catalogue-photos/${id}/history`);
}

export async function fetchProtectedCataloguePhotoBlob(id: string): Promise<Blob> {
  return apiFetchBlob(`/admin/catalogue-photos/${id}/image`);
}

export async function uploadCataloguePhotoDraft(
  formData: FormData,
): Promise<AdminCataloguePhotoItem> {
  return apiPostForm<AdminCataloguePhotoItem>('/admin/catalogue-photos', formData);
}

export async function updateCataloguePhotoMetadata(
  id: string,
  formData: FormData,
): Promise<AdminCataloguePhotoItem> {
  return apiPatchForm<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}`, formData);
}

export async function replaceCataloguePhotoVersion(
  id: string,
  formData: FormData,
): Promise<{
  photo: AdminCataloguePhotoItem;
  replacedPhotoId: string;
  oldVersionUsageCount: number;
}> {
  return apiPostForm(`/admin/catalogue-photos/${id}/replace`, formData);
}

export async function approveCataloguePhoto(
  id: string,
  setAsDefault?: boolean,
): Promise<AdminCataloguePhotoItem> {
  return apiPost<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}/approve`, {
    ...(setAsDefault !== undefined ? { setAsDefault } : {}),
  });
}

export async function rejectCataloguePhoto(
  id: string,
  reason?: string,
): Promise<AdminCataloguePhotoItem> {
  return apiPost<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}/reject`, {
    ...(reason ? { reason } : {}),
  });
}

export async function setDefaultCataloguePhoto(id: string): Promise<AdminCataloguePhotoItem> {
  return apiPost<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}/set-default`, {});
}

export async function retireCataloguePhoto(
  id: string,
  reason?: string,
): Promise<AdminCataloguePhotoItem> {
  return apiPost<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}/retire`, {
    ...(reason ? { reason } : {}),
  });
}

export async function restoreCataloguePhoto(id: string): Promise<AdminCataloguePhotoItem> {
  return apiPost<AdminCataloguePhotoItem>(`/admin/catalogue-photos/${id}/restore`, {});
}

export async function bulkSwitchCatalogueListings(
  toPhotoId: string,
  fromPhotoId: string,
): Promise<{ fromPhotoId: string; toPhotoId: string; switchedCount: number }> {
  return apiPost(`/admin/catalogue-photos/${toPhotoId}/switch-listings`, {
    fromPhotoId,
    confirmBulkSwitch: true,
  });
}
