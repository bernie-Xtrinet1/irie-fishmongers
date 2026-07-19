import type {
  AdminReview,
  AdminReviewDetail,
  ComplianceScoreExplanation,
  Paginated,
  ReviewModerationStatus,
} from '@iriefishmongers/types';

import { apiGet, apiPost } from '@/lib/api-client';

export interface ListAdminReviewsParams {
  page: number;
  pageSize: number;
  moderationStatus?: ReviewModerationStatus;
  vendorId?: string;
  productId?: string;
  rating?: number;
  deliveryWasRejected?: boolean;
}

export async function fetchAdminReviews(params: ListAdminReviewsParams): Promise<Paginated<AdminReview>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.moderationStatus) search.set('moderationStatus', params.moderationStatus);
  if (params.vendorId) search.set('vendorId', params.vendorId);
  if (params.productId) search.set('productId', params.productId);
  if (params.rating !== undefined) search.set('rating', String(params.rating));
  if (params.deliveryWasRejected !== undefined) {
    search.set('deliveryWasRejected', String(params.deliveryWasRejected));
  }

  return apiGet<Paginated<AdminReview>>(`/admin/reviews?${search.toString()}`);
}

export async function fetchAdminReviewDetail(reviewId: string): Promise<AdminReviewDetail> {
  return apiGet<AdminReviewDetail>(`/admin/reviews/${reviewId}`);
}

export async function removeReview(reviewId: string, reason: string): Promise<AdminReview> {
  return apiPost<AdminReview>(`/admin/reviews/${reviewId}/remove`, { reason });
}

export async function fetchComplianceScoreExplanation(vendorId: string): Promise<ComplianceScoreExplanation> {
  return apiGet<ComplianceScoreExplanation>(`/admin/vendors/${vendorId}/compliance-score`);
}
