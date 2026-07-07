import type { Paginated, ProductDetail, ProductResponse } from '@iriefishmongers/types';

import { apiGet } from '../api-client';

export function fetchProductDetail(productId: string): Promise<ProductDetail> {
  return apiGet<ProductDetail>(`/products/${productId}/detail`);
}

export function fetchProductsByVendor(
  vendorId: string,
  page = 1,
  pageSize = 20,
): Promise<Paginated<ProductResponse>> {
  const params = new URLSearchParams({ vendorId, page: String(page), pageSize: String(pageSize) });
  return apiGet<Paginated<ProductResponse>>(`/products?${params.toString()}`);
}
