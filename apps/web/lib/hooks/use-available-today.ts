import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type {
  DailyListingResponse,
  PaginatedAvailableToday,
  QueryDailyListings,
} from '@iriefishmongers/types';

import {
  fetchAvailableToday,
  fetchDailyListing,
  fetchListingsByCatalogueItem,
} from '../api/daily-listings';

export function useAvailableToday(
  query?: QueryDailyListings,
): UseQueryResult<PaginatedAvailableToday, Error> {
  return useQuery({
    queryKey: ['available-today', query],
    queryFn: () => fetchAvailableToday(query),
  });
}

export function useCatalogueItemListings(
  catalogueItemId: string | null,
): UseQueryResult<DailyListingResponse[], Error> {
  return useQuery({
    queryKey: ['catalogue-item-listings', catalogueItemId],
    queryFn: () => fetchListingsByCatalogueItem(catalogueItemId!),
    enabled: Boolean(catalogueItemId),
  });
}

export function useDailyListing(
  listingId: string | null,
): UseQueryResult<DailyListingResponse, Error> {
  return useQuery({
    queryKey: ['daily-listing', listingId],
    queryFn: () => fetchDailyListing(listingId!),
    enabled: Boolean(listingId),
  });
}
