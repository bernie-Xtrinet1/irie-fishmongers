import type {
  DailyListingResponse,
  PaginatedAvailableToday,
  PaginatedDailyListings,
  QueryDailyListings,
} from '@iriefishmongers/types';

import { apiGet } from '../api-client';

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
