'use client';

import { ReviewModerationStatus } from '@iriefishmongers/types';
import { StarRating } from '@iriefishmongers/ui';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PaginationControls } from '@/components/pagination-controls';
import { RemoveReviewDialog } from '@/components/reviews/remove-review-dialog';
import { ReviewDetailDialog } from '@/components/reviews/review-detail-dialog';
import { formatEnumLabel } from '@/lib/format';
import { useAdminReviews } from '@/lib/hooks/use-reviews';

const PAGE_SIZE = 20;

const STATUS_BADGE_VARIANT: Record<ReviewModerationStatus, 'success' | 'neutral' | 'danger'> = {
  [ReviewModerationStatus.VISIBLE]: 'success',
  [ReviewModerationStatus.REMOVED_BY_AUTHOR]: 'neutral',
  [ReviewModerationStatus.REMOVED_BY_ADMIN]: 'danger',
};

const DELIVERY_FILTER_VALUES = { ALL: 'ALL', REJECTED: 'REJECTED', NOT_REJECTED: 'NOT_REJECTED' } as const;

export function ReviewsView(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [detailReviewId, setDetailReviewId] = useState<string | null>(null);

  const page = Number(searchParams.get('page') ?? '1') || 1;
  const moderationStatus = (searchParams.get('moderationStatus') as ReviewModerationStatus | null) ?? undefined;
  const deliveryParam = searchParams.get('deliveryWasRejected');
  const deliveryWasRejected =
    deliveryParam === 'true' ? true : deliveryParam === 'false' ? false : undefined;

  const query = useAdminReviews({ page, pageSize: PAGE_SIZE, moderationStatus, deliveryWasRejected });

  function updateSearchParams(next: Record<string, string | undefined>): void {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
      if (key !== 'page') params.delete('page');
    }
    const queryString = params.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }

  const deliverySelectValue =
    deliveryWasRejected === true
      ? DELIVERY_FILTER_VALUES.REJECTED
      : deliveryWasRejected === false
        ? DELIVERY_FILTER_VALUES.NOT_REJECTED
        : DELIVERY_FILTER_VALUES.ALL;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-gray-900">Review Moderation</h1>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="review-status-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Status
          </label>
          <Select
            value={moderationStatus ?? 'ALL'}
            onValueChange={(value) => updateSearchParams({ moderationStatus: value === 'ALL' ? undefined : value })}
          >
            <SelectTrigger id="review-status-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {Object.values(ReviewModerationStatus).map((value) => (
                <SelectItem key={value} value={value}>
                  {formatEnumLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="review-delivery-filter" className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Delivery
          </label>
          <Select
            value={deliverySelectValue}
            onValueChange={(value) =>
              updateSearchParams({
                deliveryWasRejected:
                  value === DELIVERY_FILTER_VALUES.REJECTED
                    ? 'true'
                    : value === DELIVERY_FILTER_VALUES.NOT_REJECTED
                      ? 'false'
                      : undefined,
              })
            }
          >
            <SelectTrigger id="review-delivery-filter" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DELIVERY_FILTER_VALUES.ALL}>All deliveries</SelectItem>
              <SelectItem value={DELIVERY_FILTER_VALUES.REJECTED}>Delivery rejected</SelectItem>
              <SelectItem value={DELIVERY_FILTER_VALUES.NOT_REJECTED}>Delivery not rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="p-0">
        {query.isPending ? (
          <div className="flex flex-col gap-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-irie-red">Unable to load reviews.</p>
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : query.data ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Author</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-gray-500">
                      No reviews match these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  query.data.items.map((review) => (
                    <TableRow key={review.id}>
                      <TableCell className="font-medium">{review.authorDisplayName}</TableCell>
                      <TableCell>
                        <StarRating value={review.rating} size="sm" readOnly />
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={review.productName ?? 'Vendor review'}>
                        {review.productName ?? 'Vendor review'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGE_VARIANT[review.moderationStatus]}>
                          {formatEnumLabel(review.moderationStatus)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {review.deliveryWasRejected ? <Badge variant="warning">Rejected</Badge> : '—'}
                      </TableCell>
                      <TableCell>{new Date(review.createdAt).toLocaleDateString('en-JM')}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" onClick={() => setDetailReviewId(review.id)}>
                            View details
                          </Button>
                          {review.moderationStatus !== ReviewModerationStatus.REMOVED_BY_ADMIN ? (
                            <RemoveReviewDialog reviewId={review.id} />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <PaginationControls
              page={query.data.page}
              pageSize={query.data.pageSize}
              total={query.data.total}
              onPageChange={(nextPage) => updateSearchParams({ page: String(nextPage) })}
            />
          </>
        ) : null}
      </Card>

      <ReviewDetailDialog
        reviewId={detailReviewId}
        onOpenChange={(open) => {
          if (!open) setDetailReviewId(null);
        }}
      />
    </div>
  );
}
