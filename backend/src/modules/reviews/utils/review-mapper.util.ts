import { AdminReviewEntity } from '../entities/admin-review.entity';
import { ReviewResponseEntity } from '../entities/review-response.entity';
import { AdminReview, PublicReview } from '../repositories/reviews.repository';

// Masks a customer's legal name to first name + last initial (e.g.
// "Bernard W.") for public display. If the author account is gone
// (SetNull on user deletion), fall back to "Verified Buyer" - the review
// still represents a real completed purchase, just an anonymized one.
export function maskAuthorName(firstName: string | null, lastName: string | null): string {
  if (!firstName) {
    return 'Verified Buyer';
  }
  const initial = lastName?.trim()?.charAt(0);
  return initial ? `${firstName} ${initial.toUpperCase()}.` : firstName;
}

export function toReviewResponse(review: PublicReview): ReviewResponseEntity {
  return {
    id: review.id,
    authorDisplayName: maskAuthorName(review.author?.firstName ?? null, review.author?.lastName ?? null),
    verifiedPurchase: true,
    rating: review.rating,
    title: review.title,
    body: review.body,
    productId: review.productId,
    productName: review.product?.name ?? null,
    createdAt: review.createdAt,
    editedAt: review.editedAt,
  };
}

// The moderator view exposes internals the public shape hides (authorId,
// moderation status, removal metadata) but still masks the display name -
// there's no reason to surface a customer's full legal name even to admins.
// deliveryWasRejected is derived from the joined Delivery at read time.
export function toAdminReviewResponse(review: AdminReview): AdminReviewEntity {
  return {
    id: review.id,
    authorId: review.authorId,
    authorDisplayName: maskAuthorName(review.author?.firstName ?? null, review.author?.lastName ?? null),
    vendorId: review.vendorId,
    productId: review.productId,
    productName: review.product?.name ?? null,
    vendorOrderId: review.vendorOrderId,
    rating: review.rating,
    title: review.title,
    body: review.body,
    moderationStatus: review.moderationStatus,
    removedById: review.removedById,
    removalReason: review.removalReason,
    removedAt: review.removedAt,
    deliveryWasRejected: review.vendorOrder.delivery?.customerAcceptanceStatus === 'REJECTED',
    editedAt: review.editedAt,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

// Ratings never leave the backend as raw floats - always one decimal
// place (e.g. 4.3), so the frontend's numeric label and half-star visual
// agree at their own resolutions.
export function roundRatingToOneDecimal(average: number | null): number | null {
  if (average === null) {
    return null;
  }
  return Math.round(average * 10) / 10;
}
