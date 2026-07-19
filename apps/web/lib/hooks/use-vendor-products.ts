import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Paginated, ProductResponse } from '@iriefishmongers/types';

import { fetchProductsByVendor } from '../api/products';

export function useVendorProducts(vendorId: string): UseQueryResult<Paginated<ProductResponse>, Error> {
  return useQuery({
    queryKey: ['vendor-products', vendorId],
    queryFn: () => fetchProductsByVendor(vendorId),
  });
}
