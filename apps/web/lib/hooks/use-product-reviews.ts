import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PaginatedReviews } from '@iriefishmongers/types';

import { fetchProductReviews } from '../api/reviews';

export function useProductReviews(productId: string): UseQueryResult<PaginatedReviews, Error> {
  return useQuery({
    queryKey: ['product-reviews', productId],
    queryFn: () => fetchProductReviews(productId),
  });
}
