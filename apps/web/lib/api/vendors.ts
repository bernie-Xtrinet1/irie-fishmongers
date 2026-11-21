import type {
  LandingSite,
  ManagedSpecies,
  Paginated,
  PaginatedCatalogueItems,
  RegulatoryEvaluationResult,
  SeafoodLotAdmin,
  VendorAdmin,
  VendorComplianceStatus,
  VendorProfile,
} from '@iriefishmongers/types';

import { apiGet, apiPost } from '../api-client';

export function fetchVendorProfile(vendorId: string): Promise<VendorProfile> {
  return apiGet<VendorProfile>(`/vendors/${vendorId}/profile`);
}

export function fetchMyVendorProfile(): Promise<VendorAdmin> {
  return apiGet<VendorAdmin>('/vendors/me');
}

export function fetchMyVendorCompliance(): Promise<VendorComplianceStatus> {
  return apiGet<VendorComplianceStatus>('/vendors/me/compliance-status');
}

export function fetchMySeafoodLots(
  page = 1,
  pageSize = 100,
): Promise<Paginated<SeafoodLotAdmin>> {
  return apiGet<Paginated<SeafoodLotAdmin>>(
    `/seafood-lots/mine?page=${page}&pageSize=${pageSize}`,
  );
}

export function fetchPublishedCatalogue(
  limit = 100,
): Promise<PaginatedCatalogueItems> {
  return apiGet<PaginatedCatalogueItems>(
    `/catalogue?lifecycleStatus=PUBLISHED&limit=${limit}`,
  );
}

export function fetchLandingSites(): Promise<LandingSite[]> {
  return apiGet<LandingSite[]>('/landing-sites');
}

export function fetchManagedSpecies(): Promise<ManagedSpecies[]> {
  return apiGet<ManagedSpecies[]>('/species');
}

export function evaluateRegulatoryEligibility(input: {
  catalogueItemId: string;
  vendorDailyListingId?: string;
  seafoodLotId?: string;
}): Promise<RegulatoryEvaluationResult> {
  return apiPost<RegulatoryEvaluationResult>('/catalogue/regulatory/evaluate', input);
}
