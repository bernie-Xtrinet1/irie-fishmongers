import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, Review } from '@prisma/client';

import { CreateReviewDto } from '../dto/create-review.dto';
import { PublicReview, ReviewsRepository } from '../repositories/reviews.repository';
import { ReviewEligibilityService } from './review-eligibility.service';
import { ReviewsService } from './reviews.service';

function buildReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    authorId: 'customer-1',
    vendorId: 'vendor-1',
    productId: null,
    vendorOrderId: 'vo-1',
    rating: 5,
    title: 'Great',
    body: 'Very fresh snapper, delivered cold.',
    moderationStatus: 'VISIBLE',
    removedById: null,
    removalReason: null,
    removedAt: null,
    editedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildPublicReview(overrides: Partial<Review> = {}): PublicReview {
  return {
    ...buildReview(overrides),
    author: { firstName: 'Bernard', lastName: 'Williams' },
    product: null,
  };
}

describe('ReviewsService', () => {
  let reviewsRepository: jest.Mocked<
    Pick<
      ReviewsRepository,
      'create' | 'findById' | 'findPublicById' | 'update' | 'softDeleteByAuthor' | 'restore'
    >
  >;
  let eligibilityService: jest.Mocked<Pick<ReviewEligibilityService, 'assertEligible' | 'checkEligibility'>>;
  let service: ReviewsService;

  const dto: CreateReviewDto = {
    vendorOrderId: 'vo-1',
    rating: 5,
    body: 'Very fresh snapper, delivered cold.',
  };

  beforeEach(() => {
    reviewsRepository = {
      create: jest.fn().mockResolvedValue(buildReview()),
      findById: jest.fn(),
      findPublicById: jest.fn().mockResolvedValue(buildPublicReview()),
      update: jest.fn().mockResolvedValue(buildReview()),
      softDeleteByAuthor: jest.fn().mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_AUTHOR' })),
      restore: jest.fn().mockResolvedValue(buildReview()),
    };
    eligibilityService = {
      assertEligible: jest.fn().mockResolvedValue({ vendorId: 'vendor-1', deliveryWasRejected: false }),
      checkEligibility: jest.fn(),
    };
    service = new ReviewsService(
      reviewsRepository as unknown as ReviewsRepository,
      eligibilityService as unknown as ReviewEligibilityService,
    );
  });

  describe('create', () => {
    it('creates a review after asserting eligibility and masks the author name', async () => {
      const result = await service.create('customer-1', dto);

      expect(eligibilityService.assertEligible).toHaveBeenCalledWith('customer-1', 'vo-1', undefined);
      expect(reviewsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ authorId: 'customer-1', vendorId: 'vendor-1', vendorOrderId: 'vo-1' }),
      );
      expect(result.authorDisplayName).toBe('Bernard W.');
      expect(result.verifiedPurchase).toBe(true);
    });

    it('translates a unique-violation into a 409 (duplicate review)', async () => {
      reviewsRepository.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6.0.0' }),
      );

      await expect(service.create('customer-1', dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('rejects editing a review the customer does not own', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ authorId: 'someone-else' }));

      await expect(service.update('customer-1', 'review-1', { rating: 4 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects editing a removed review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_AUTHOR' }));

      await expect(service.update('customer-1', 'review-1', { rating: 4 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects editing after the 14-day window', async () => {
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      reviewsRepository.findById.mockResolvedValue(buildReview({ createdAt: old }));

      await expect(service.update('customer-1', 'review-1', { rating: 4 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('updates a visible, owned, in-window review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview());

      await service.update('customer-1', 'review-1', { rating: 4 });

      expect(reviewsRepository.update).toHaveBeenCalledWith('review-1', {
        rating: 4,
        title: undefined,
        body: undefined,
      });
    });
  });

  describe('softDelete', () => {
    it('refuses to touch an admin-removed review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_ADMIN' }));

      await expect(service.softDelete('customer-1', 'review-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is a no-op when the review is already author-removed', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_AUTHOR' }));

      await service.softDelete('customer-1', 'review-1');

      expect(reviewsRepository.softDeleteByAuthor).not.toHaveBeenCalled();
    });

    it('soft-deletes a visible owned review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview());

      await service.softDelete('customer-1', 'review-1');

      expect(reviewsRepository.softDeleteByAuthor).toHaveBeenCalledWith('review-1');
    });
  });

  describe('restore', () => {
    it('refuses to restore an admin-removed review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_ADMIN' }));

      await expect(service.restore('customer-1', 'review-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects restoring an already-visible review', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'VISIBLE' }));

      await expect(service.restore('customer-1', 'review-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('restores an author-removed review within the window', async () => {
      reviewsRepository.findById.mockResolvedValue(buildReview({ moderationStatus: 'REMOVED_BY_AUTHOR' }));

      await service.restore('customer-1', 'review-1');

      expect(reviewsRepository.restore).toHaveBeenCalledWith('review-1');
    });

    it('rejects restoring after the 14-day window', async () => {
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      reviewsRepository.findById.mockResolvedValue(
        buildReview({ moderationStatus: 'REMOVED_BY_AUTHOR', createdAt: old }),
      );

      await expect(service.restore('customer-1', 'review-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound when the review does not exist', async () => {
      reviewsRepository.findById.mockResolvedValue(null);

      await expect(service.restore('customer-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
