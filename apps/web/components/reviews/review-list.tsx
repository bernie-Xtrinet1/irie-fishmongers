import type { ReviewSummary } from '@iriefishmongers/types';
import { StarRating } from '@iriefishmongers/ui';
import type { ReactElement } from 'react';

import { formatRelativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';

// Shared renderer for a list of public reviews (Phase 13E). Content is plain
// text - never dangerouslySetInnerHTML. showProductName is used on the
// vendor profile, where a review may target a specific product.
export function ReviewList({
  reviews,
  showProductName = false,
}: {
  reviews: ReviewSummary[];
  showProductName?: boolean;
}): ReactElement {
  return (
    <ul className="space-y-4">
      {reviews.map((review) => (
        <li key={review.id} className="border-b border-gray-100 pb-4 last:border-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <StarRating value={review.rating} size="sm" readOnly />
            <span className="text-sm font-medium text-gray-900">{review.authorDisplayName}</span>
            {review.verifiedPurchase ? (
              <Badge variant="success" className="text-xs">
                Verified Buyer
              </Badge>
            ) : null}
            <span className="ml-auto text-xs text-gray-500">{formatRelativeTime(review.createdAt)}</span>
          </div>
          {showProductName && review.productName ? (
            <p className="mt-1 text-xs text-gray-500">On {review.productName}</p>
          ) : null}
          {review.title ? <p className="mt-2 text-sm font-medium text-gray-900">{review.title}</p> : null}
          <p className="mt-1 whitespace-pre-line text-sm text-gray-700">{review.body}</p>
          {review.editedAt ? <p className="mt-1 text-xs text-gray-400">(edited)</p> : null}
        </li>
      ))}
    </ul>
  );
}
