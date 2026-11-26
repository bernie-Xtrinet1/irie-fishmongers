import type {
  CategoryOption,
  CreateProductInput,
  Paginated,
  ProductDetail,
  ProductResponse,
  UpdateProductInput,
} from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '../api-client';

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

export function fetchCategories(): Promise<CategoryOption[]> {
  return apiGet<CategoryOption[]>('/categories');
}

export function fetchMyProducts(page = 1, pageSize = 100): Promise<Paginated<ProductResponse>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiGet<Paginated<ProductResponse>>(`/products/mine?${params.toString()}`);
}

export function createProduct(input: CreateProductInput): Promise<ProductResponse> {
  return apiPost<ProductResponse>('/products', input);
}

export function updateProduct(
  productId: string,
  input: UpdateProductInput,
): Promise<ProductResponse> {
  return apiPatch<ProductResponse>(`/products/${productId}`, input);
}

export function adjustProductStock(
  productId: string,
  delta: number,
): Promise<ProductResponse> {
  return apiPatch<ProductResponse>(`/products/${productId}/stock`, { delta });
}

export function setProductActive(
  productId: string,
  active: boolean,
): Promise<ProductResponse> {
  const action = active ? 'reactivate' : 'deactivate';
  return apiPatch<ProductResponse>(`/products/${productId}/${action}`, {});
}
