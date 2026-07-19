import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { ListAdminReviewsDto } from '../dto/list-admin-reviews.dto';
import { RemoveReviewDto } from '../dto/remove-review.dto';
import { AdminReviewDetailEntity } from '../entities/admin-review-detail.entity';
import { AdminReviewEntity } from '../entities/admin-review.entity';
import { PaginatedAdminReviewsEntity } from '../entities/paginated-admin-reviews.entity';
import { ReviewAuditLogsRepository } from '../repositories/review-audit-logs.repository';
import { ReviewsRepository } from '../repositories/reviews.repository';
import { toAdminReviewResponse } from '../utils/review-mapper.util';

@Injectable()
export class ReviewModerationService {
  constructor(
    private readonly reviewsRepository: ReviewsRepository,
    private readonly reviewAuditLogsRepository: ReviewAuditLogsRepository,
  ) {}

  async list(dto: ListAdminReviewsDto): Promise<PaginatedAdminReviewsEntity> {
    const { items, total } = await this.reviewsRepository.listForAdmin(
      {
        moderationStatus: dto.moderationStatus,
        vendorId: dto.vendorId,
        productId: dto.productId,
        rating: dto.rating,
        deliveryWasRejected: dto.deliveryWasRejected,
        createdAfter: dto.createdAfter,
        createdBefore: dto.createdBefore,
      },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map(toAdminReviewResponse),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async getById(id: string): Promise<AdminReviewDetailEntity> {
    const review = await this.reviewsRepository.findAdminById(id);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    const auditLogs = await this.reviewAuditLogsRepository.findByReviewId(id);

    return {
      ...toAdminReviewResponse(review),
      auditLogs: auditLogs.map((log) => ({
        id: log.id,
        reviewId: log.reviewId,
        actorId: log.actorId,
        action: log.action,
        beforeValue: log.beforeValue,
        afterValue: log.afterValue,
        reason: log.reason,
        createdAt: log.createdAt,
      })),
    };
  }

  // Removal and its audit record commit in one transaction (see
  // ReviewsRepository.removeByAdmin) so a review is never admin-removed
  // without an accountable trail. Already-admin-removed reviews are a no-op
  // conflict rather than a second removal.
  async remove(
    actorId: string,
    id: string,
    dto: RemoveReviewDto,
    ipAddress?: string,
  ): Promise<AdminReviewEntity> {
    const review = await this.reviewsRepository.findAdminById(id);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (review.moderationStatus === 'REMOVED_BY_ADMIN') {
      throw new BadRequestException('This review has already been removed by an administrator');
    }

    const updated = await this.reviewsRepository.removeByAdmin({
      reviewId: id,
      actorId,
      reason: dto.reason,
      audit: {
        reviewId: id,
        actorId,
        action: 'REMOVED_BY_ADMIN',
        beforeValue: { moderationStatus: review.moderationStatus },
        afterValue: { moderationStatus: 'REMOVED_BY_ADMIN' },
        reason: dto.reason,
        ipAddress,
      },
    });

    return toAdminReviewResponse(updated);
  }
}
