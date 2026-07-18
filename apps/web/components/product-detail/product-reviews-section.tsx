import { StarRating } from '@iriefishmongers/ui';
import type { ReactElement } from 'react';

import { useProductReviews } from '@/lib/hooks/use-product-reviews';
import { ReviewList } from '@/components/reviews/review-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// Product reviews block below the product detail card grid (Phase 13E),
// following the same skeleton/error/empty conventions as the rest of the
// page.
export function ProductReviewsSection({ productId }: { productId: string }): ReactElement {
  const { data, isLoading, isError } = useProductReviews(productId);

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Product Reviews</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isError ? (
          <p className="text-sm text-gray-500">Reviews are unavailable right now.</p>
        ) : !data || data.total === 0 ? (
          <p className="text-sm text-gray-500">This product has no reviews yet.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {data.averageRating !== null ? (
                <>
                  <StarRating value={data.averageRating} size="sm" readOnly />
                  <span className="text-sm font-medium text-gray-900">{data.averageRating.toFixed(1)}</span>
                </>
              ) : null}
              <span className="text-sm text-gray-500">
                ({data.total} review{data.total === 1 ? '' : 's'})
              </span>
            </div>
            <ReviewList reviews={data.items} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
