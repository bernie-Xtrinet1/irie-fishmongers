import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Review, ReviewAuditLog } from '@prisma/client';

import { RemoveReviewDto } from '../dto/remove-review.dto';
import { AdminReview, ReviewsRepository } from '../repositories/reviews.repository';
import { ReviewAuditLogsRepository } from '../repositories/review-audit-logs.repository';
import { ReviewModerationService } from './review-moderation.service';

function buildAdminReview(overrides: Partial<Review> = {}): AdminReview {
  const base: Review = {
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
  return {
    ...base,
    author: { firstName: 'Bernard', lastName: 'Williams' },
    product: null,
    vendorOrder: { delivery: { customerAcceptanceStatus: 'ACCEPTED' } },
  };
}

describe('ReviewModerationService', () => {
  let reviewsRepository: jest.Mocked<
    Pick<ReviewsRepository, 'findAdminById' | 'listForAdmin' | 'removeByAdmin'>
  >;
  let auditLogsRepository: jest.Mocked<Pick<ReviewAuditLogsRepository, 'findByReviewId'>>;
  let service: ReviewModerationService;

  const dto: RemoveReviewDto = { reason: 'Contains abusive language' };

  beforeEach(() => {
    reviewsRepository = {
      findAdminById: jest.fn(),
      listForAdmin: jest.fn(),
      removeByAdmin: jest.fn(),
    };
    auditLogsRepository = { findByReviewId: jest.fn() };
    service = new ReviewModerationService(
      reviewsRepository as unknown as ReviewsRepository,
      auditLogsRepository as unknown as ReviewAuditLogsRepository,
    );
  });

  describe('remove', () => {
    it('removes a visible review and passes an audit entry to the transactional repository call', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(buildAdminReview());
      reviewsRepository.removeByAdmin.mockResolvedValue(
        buildAdminReview({ moderationStatus: 'REMOVED_BY_ADMIN', removedById: 'admin-1' }),
      );

      const result = await service.remove('admin-1', 'review-1', dto, '203.0.113.5');

      const input = reviewsRepository.removeByAdmin.mock.calls[0]?.[0];
      expect(input).toMatchObject({
        reviewId: 'review-1',
        actorId: 'admin-1',
        reason: 'Contains abusive language',
      });
      // The audit entry runs in the same transaction as the update.
      expect(input?.audit).toMatchObject({
        reviewId: 'review-1',
        actorId: 'admin-1',
        action: 'REMOVED_BY_ADMIN',
        reason: 'Contains abusive language',
        ipAddress: '203.0.113.5',
      });
      expect(result.moderationStatus).toBe('REMOVED_BY_ADMIN');
    });

    it('throws NotFound when the review does not exist', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(null);

      await expect(service.remove('admin-1', 'missing', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(reviewsRepository.removeByAdmin).not.toHaveBeenCalled();
    });

    it('rejects removing a review that is already admin-removed', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(
        buildAdminReview({ moderationStatus: 'REMOVED_BY_ADMIN' }),
      );

      await expect(service.remove('admin-1', 'review-1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(reviewsRepository.removeByAdmin).not.toHaveBeenCalled();
    });

    it('surfaces a failed transactional write (audit insert failure keeps the review VISIBLE)', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(buildAdminReview());
      // removeByAdmin runs the review update and the audit insert in one
      // $transaction; if the audit insert throws, the whole thing rejects
      // and nothing is committed.
      reviewsRepository.removeByAdmin.mockRejectedValue(new Error('audit insert failed'));

      await expect(service.remove('admin-1', 'review-1', dto)).rejects.toThrow('audit insert failed');
    });
  });

  describe('getById', () => {
    it('returns the review with its mapped audit trail', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(
        buildAdminReview({ moderationStatus: 'REMOVED_BY_ADMIN', removedById: 'admin-1' }),
      );
      const log: ReviewAuditLog = {
        id: 'log-1',
        reviewId: 'review-1',
        actorId: 'admin-1',
        action: 'REMOVED_BY_ADMIN',
        beforeValue: { moderationStatus: 'VISIBLE' },
        afterValue: { moderationStatus: 'REMOVED_BY_ADMIN' },
        reason: 'Contains abusive language',
        ipAddress: '203.0.113.5',
        createdAt: new Date(),
      };
      auditLogsRepository.findByReviewId.mockResolvedValue([log]);

      const result = await service.getById('review-1');

      expect(result.auditLogs).toHaveLength(1);
      expect(result.auditLogs[0]?.action).toBe('REMOVED_BY_ADMIN');
      // Even admins never see the full legal name.
      expect(result.authorDisplayName).toBe('Bernard W.');
    });

    it('throws NotFound when the review does not exist', async () => {
      reviewsRepository.findAdminById.mockResolvedValue(null);

      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('maps rows and computes deliveryWasRejected from the joined delivery', async () => {
      reviewsRepository.listForAdmin.mockResolvedValue({
        items: [
          buildAdminReview(),
          {
            ...buildAdminReview({ id: 'review-2' }),
            vendorOrder: { delivery: { customerAcceptanceStatus: 'REJECTED' } },
          },
        ],
        total: 2,
      });

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.items[0]?.deliveryWasRejected).toBe(false);
      expect(result.items[1]?.deliveryWasRejected).toBe(true);
    });
  });
});
