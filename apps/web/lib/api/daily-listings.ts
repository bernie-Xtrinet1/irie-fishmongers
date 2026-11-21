import type {
  AddListingPhotoInput,
  CreateDailyListingInput,
  DailyListingPhotoResponse,
  DailyListingResponse,
  PaginatedAvailableToday,
  PaginatedDailyListings,
  QueryDailyListings,
  UpdateDailyListingInput,
} from '@iriefishmongers/types';

import { apiDelete, apiGet, apiPatch, apiPost } from '../api-client';

function buildQueryParams(query?: QueryDailyListings): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

export function fetchAvailableToday(
  query?: QueryDailyListings,
): Promise<PaginatedAvailableToday> {
  return apiGet<PaginatedAvailableToday>(
    `/daily-listings/available-today${buildQueryParams(query)}`,
  );
}

export function fetchActiveListings(
  query?: QueryDailyListings,
): Promise<PaginatedDailyListings> {
  return apiGet<PaginatedDailyListings>(
    `/daily-listings${buildQueryParams(query)}`,
  );
}

export function fetchListingsByCatalogueItem(
  catalogueItemId: string,
): Promise<DailyListingResponse[]> {
  return apiGet<DailyListingResponse[]>(
    `/daily-listings/catalogue-item/${encodeURIComponent(catalogueItemId)}`,
  );
}

export function fetchDailyListing(
  id: string,
): Promise<DailyListingResponse> {
  return apiGet<DailyListingResponse>(
    `/daily-listings/${encodeURIComponent(id)}`,
  );
}

export function fetchMyDailyListings(
  query?: QueryDailyListings,
): Promise<PaginatedDailyListings> {
  return apiGet<PaginatedDailyListings>(
    `/vendor/daily-listings${buildQueryParams(query)}`,
  );
}

export function fetchMyDailyListing(
  id: string,
): Promise<DailyListingResponse> {
  return apiGet<DailyListingResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}`,
  );
}

export function createDailyListing(
  input: CreateDailyListingInput,
): Promise<DailyListingResponse> {
  return apiPost<DailyListingResponse>('/vendor/daily-listings', input);
}

export function updateDailyListing(
  id: string,
  input: UpdateDailyListingInput,
): Promise<DailyListingResponse> {
  return apiPatch<DailyListingResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}`,
    input,
  );
}

export function publishDailyListing(
  id: string,
): Promise<DailyListingResponse> {
  return apiPost<DailyListingResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}/publish`,
    {},
  );
}

export function withdrawDailyListing(
  id: string,
  reason: string,
): Promise<DailyListingResponse> {
  return apiPost<DailyListingResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}/withdraw`,
    { reason },
  );
}

export function addDailyListingPhoto(
  id: string,
  input: AddListingPhotoInput,
): Promise<DailyListingPhotoResponse> {
  return apiPost<DailyListingPhotoResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}/photos`,
    input,
  );
}

export function setPrimaryDailyListingPhoto(
  id: string,
  photoId: string,
): Promise<DailyListingPhotoResponse> {
  return apiPatch<DailyListingPhotoResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}/primary`,
    {},
  );
}

export function withdrawDailyListingPhoto(
  id: string,
  photoId: string,
  reason: string,
): Promise<DailyListingPhotoResponse> {
  return apiDelete<DailyListingPhotoResponse>(
    `/vendor/daily-listings/${encodeURIComponent(id)}/photos/${encodeURIComponent(photoId)}`,
    {
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason }),
    },
  );
}
