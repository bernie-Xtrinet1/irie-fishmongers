import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ReviewsRepository, VendorOrderForEligibility } from '../repositories/reviews.repository';
import { ReviewEligibilityService } from './review-eligibility.service';

function buildVendorOrder(overrides: Partial<VendorOrderForEligibility> = {}): VendorOrderForEligibility {
  return {
    vendorId: 'vendor-1',
    status: 'DELIVERED',
    order: { customerId: 'customer-1' },
    items: [{ productId: 'product-1' }],
    delivery: { deliveredAt: new Date(), customerAcceptanceStatus: 'ACCEPTED' },
    ...overrides,
  };
}

describe('ReviewEligibilityService', () => {
  let reviewsRepository: jest.Mocked<Pick<ReviewsRepository, 'findVendorOrderForEligibility'>>;
  let service: ReviewEligibilityService;

  beforeEach(() => {
    reviewsRepository = { findVendorOrderForEligibility: jest.fn() };
    service = new ReviewEligibilityService(reviewsRepository as unknown as ReviewsRepository);
  });

  describe('assertEligible', () => {
    it('resolves with vendorId and deliveryWasRejected for a delivered, accepted order', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(buildVendorOrder());

      const result = await service.assertEligible('customer-1', 'vo-1', 'product-1');

      expect(result).toEqual({ vendorId: 'vendor-1', deliveryWasRejected: false });
    });

    it('flags but still allows a review when the customer rejected the delivery', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(
        buildVendorOrder({ delivery: { deliveredAt: new Date(), customerAcceptanceStatus: 'REJECTED' } }),
      );

      const result = await service.assertEligible('customer-1', 'vo-1');

      expect(result.deliveryWasRejected).toBe(true);
    });

    it('throws NotFound when the order does not exist', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(null);

      await expect(service.assertEligible('customer-1', 'vo-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Forbidden when the order belongs to another customer', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(
        buildVendorOrder({ order: { customerId: 'someone-else' } }),
      );

      await expect(service.assertEligible('customer-1', 'vo-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the order is not delivered', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(
        buildVendorOrder({ status: 'DELIVERY_FAILED' }),
      );

      await expect(service.assertEligible('customer-1', 'vo-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when a delivered order has no delivery record to anchor the window', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(buildVendorOrder({ delivery: null }));

      await expect(service.assertEligible('customer-1', 'vo-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when reviewing a product that was not part of the order', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(buildVendorOrder());

      await expect(service.assertEligible('customer-1', 'vo-1', 'other-product')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the 90-day creation window has passed', async () => {
      const oldDelivery = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(
        buildVendorOrder({ delivery: { deliveredAt: oldDelivery, customerAcceptanceStatus: 'ACCEPTED' } }),
      );

      await expect(service.assertEligible('customer-1', 'vo-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('checkEligibility', () => {
    it('returns eligible true with no reason on success', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(buildVendorOrder());

      await expect(service.checkEligibility('customer-1', 'vo-1')).resolves.toEqual({
        eligible: true,
        reason: null,
      });
    });

    it('returns eligible false with a reason on failure', async () => {
      reviewsRepository.findVendorOrderForEligibility.mockResolvedValue(
        buildVendorOrder({ status: 'PENDING' }),
      );

      const result = await service.checkEligibility('customer-1', 'vo-1');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('delivered');
    });
  });

  describe('assertWithinEditWindow', () => {
    it('allows edits within 14 days of creation', () => {
      const recent = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
      expect(() => ReviewEligibilityService.assertWithinEditWindow(recent)).not.toThrow();
    });

    it('rejects edits after 14 days', () => {
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      expect(() => ReviewEligibilityService.assertWithinEditWindow(old)).toThrow(BadRequestException);
    });
  });
});
