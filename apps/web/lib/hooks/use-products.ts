import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Paginated, ProductResponse } from '@iriefishmongers/types';

import { fetchProducts } from '../api/products';

export function useProducts(): UseQueryResult<Paginated<ProductResponse>, Error> {
  return useQuery({
    queryKey: ['products', 'catalog'],
    queryFn: () => fetchProducts(),
  });
}
