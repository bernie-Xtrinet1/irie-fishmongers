import type { Paginated, ProductDetail, ProductResponse } from '@iriefishmongers/types';

import { apiGet } from '../api-client';

export function fetchProductDetail(productId: string): Promise<ProductDetail> {
  return apiGet<ProductDetail>(`/products/${productId}/detail`);
}

// The public catalog for the storefront home page - no vendor filter, only
// active/available products (the backend already excludes inactive ones).
export function fetchProducts(page = 1, pageSize = 24): Promise<Paginated<ProductResponse>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiGet<Paginated<ProductResponse>>(`/products?${params.toString()}`);
}

export function fetchProductsByVendor(
  vendorId: string,
  page = 1,
  pageSize = 20,
): Promise<Paginated<ProductResponse>> {
  const params = new URLSearchParams({ vendorId, page: String(page), pageSize: String(pageSize) });
  return apiGet<Paginated<ProductResponse>>(`/products?${params.toString()}`);
}
