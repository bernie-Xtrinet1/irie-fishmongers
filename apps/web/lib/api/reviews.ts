import type { PaginatedReviews } from '@iriefishmongers/types';

import { apiGet } from '../api-client';

// Public, unauthenticated review reads (Phase 13E). The authenticated
// write/eligibility flow is deferred until apps/web has a customer session
// and an order-history surface to launch "Write a Review" from - there is no
// logged-in customer context on the public storefront today.
export function fetchVendorReviews(vendorId: string, page = 1, pageSize = 20): Promise<PaginatedReviews> {
  return apiGet<PaginatedReviews>(`/reviews/vendor/${vendorId}?page=${page}&pageSize=${pageSize}`);
}

export function fetchProductReviews(productId: string, page = 1, pageSize = 20): Promise<PaginatedReviews> {
  return apiGet<PaginatedReviews>(`/reviews/product/${productId}?page=${page}&pageSize=${pageSize}`);
}
