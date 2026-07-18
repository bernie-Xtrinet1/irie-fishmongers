'use client';

import type {
  AdminReview,
  AdminReviewDetail,
  ComplianceScoreExplanation,
  Paginated,
} from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchAdminReviewDetail,
  fetchAdminReviews,
  fetchComplianceScoreExplanation,
  removeReview,
  type ListAdminReviewsParams,
} from '@/lib/api/reviews';

const REVIEWS_QUERY_KEY = 'admin-reviews';

export function useAdminReviews(params: ListAdminReviewsParams): UseQueryResult<Paginated<AdminReview>> {
  return useQuery({
    queryKey: [REVIEWS_QUERY_KEY, params],
    queryFn: () => fetchAdminReviews(params),
  });
}

export function useAdminReviewDetail(reviewId: string | null): UseQueryResult<AdminReviewDetail> {
  return useQuery({
    queryKey: ['admin-review-detail', reviewId],
    queryFn: () => fetchAdminReviewDetail(reviewId as string),
    enabled: reviewId !== null,
  });
}

export function useRemoveReview(): ReturnType<
  typeof useMutation<AdminReview, Error, { reviewId: string; reason: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ reviewId, reason }: { reviewId: string; reason: string }) => removeReview(reviewId, reason),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: [REVIEWS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['admin-review-detail', variables.reviewId] });
    },
  });
}

export function useComplianceScoreExplanation(
  vendorId: string | null,
): UseQueryResult<ComplianceScoreExplanation> {
  return useQuery({
    queryKey: ['compliance-score-explanation', vendorId],
    queryFn: () => fetchComplianceScoreExplanation(vendorId as string),
    enabled: vendorId !== null,
  });
}
