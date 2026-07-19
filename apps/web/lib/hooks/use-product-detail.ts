import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ProductDetail } from '@iriefishmongers/types';

import { fetchProductDetail } from '../api/products';

export function useProductDetail(productId: string): UseQueryResult<ProductDetail, Error> {
  return useQuery({
    queryKey: ['product-detail', productId],
    queryFn: () => fetchProductDetail(productId),
  });
}
