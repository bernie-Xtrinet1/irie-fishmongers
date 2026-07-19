import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { ReviewsRepository } from '../repositories/reviews.repository';

export const REVIEW_CREATE_WINDOW_DAYS = 90;
export const REVIEW_EDIT_WINDOW_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface EligibilityResult {
  vendorId: string;
  // The customer rejected the delivery for this order. A vendor review is
  // still legitimate; a product review is allowed but flagged for
  // moderators (see the admin moderation list, Phase 13B).
  deliveryWasRejected: boolean;
}

@Injectable()
export class ReviewEligibilityService {
  constructor(private readonly reviewsRepository: ReviewsRepository) {}

  // Throwing variant used by the write paths (create). Ownership failures
  // surface as 403, missing orders as 404, and every substantive
  // "you can't review this" reason as 400 with an explanatory message.
  async assertEligible(
    customerId: string,
    vendorOrderId: string,
    productId?: string,
  ): Promise<EligibilityResult> {
    const vendorOrder = await this.reviewsRepository.findVendorOrderForEligibility(vendorOrderId);
    if (!vendorOrder) {
      throw new NotFoundException('Order not found');
    }
    if (vendorOrder.order.customerId !== customerId) {
      throw new ForbiddenException('You can only review your own orders');
    }
    if (vendorOrder.status !== 'DELIVERED') {
      throw new BadRequestException('You can only review an order after it has been delivered');
    }
    // A DELIVERED vendor order should always have a Delivery with a
    // deliveredAt; if it somehow doesn't, there is no trustworthy anchor
    // for the creation window, so the order is not reviewable rather than
    // guessing at a date.
    if (!vendorOrder.delivery?.deliveredAt) {
      throw new BadRequestException('This order has no delivery record to review against');
    }
    if (productId && !vendorOrder.items.some((item) => item.productId === productId)) {
      throw new BadRequestException('You can only review a product that was part of this order');
    }

    const daysSinceDelivered = (Date.now() - vendorOrder.delivery.deliveredAt.getTime()) / MS_PER_DAY;
    if (daysSinceDelivered > REVIEW_CREATE_WINDOW_DAYS) {
      throw new BadRequestException(
        `Reviews can only be written within ${REVIEW_CREATE_WINDOW_DAYS} days of delivery`,
      );
    }

    return {
      vendorId: vendorOrder.vendorId,
      deliveryWasRejected: vendorOrder.delivery.customerAcceptanceStatus === 'REJECTED',
    };
  }

  // Non-throwing variant for the pre-check GET endpoint - the frontend uses
  // it to show/hide the "Write a Review" control.
  async checkEligibility(
    customerId: string,
    vendorOrderId: string,
    productId?: string,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    try {
      await this.assertEligible(customerId, vendorOrderId, productId);
      return { eligible: true, reason: null };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        return { eligible: false, reason: error.message };
      }
      throw error;
    }
  }

  // Shared 14-day edit/restore window check (from review creation, not
  // delivery). Used by both edit and restore in ReviewsService.
  static assertWithinEditWindow(createdAt: Date): void {
    const daysSinceCreated = (Date.now() - createdAt.getTime()) / MS_PER_DAY;
    if (daysSinceCreated > REVIEW_EDIT_WINDOW_DAYS) {
      throw new BadRequestException(
        `Reviews can only be edited within ${REVIEW_EDIT_WINDOW_DAYS} days of being written`,
      );
    }
  }
}
