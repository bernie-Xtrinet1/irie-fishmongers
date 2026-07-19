import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PaginatedReviews } from '@iriefishmongers/types';

import { fetchVendorReviews } from '../api/reviews';

export function useVendorReviews(vendorId: string): UseQueryResult<PaginatedReviews, Error> {
  return useQuery({
    queryKey: ['vendor-reviews', vendorId],
    queryFn: () => fetchVendorReviews(vendorId),
  });
}
