import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Review } from '@prisma/client';

import { CreateReviewDto } from '../dto/create-review.dto';
import { ListReviewsDto } from '../dto/list-reviews.dto';
import { UpdateReviewDto } from '../dto/update-review.dto';
import { PaginatedReviewsEntity } from '../entities/paginated-reviews.entity';
import { ReviewEligibilityEntity } from '../entities/review-eligibility.entity';
import { ReviewResponseEntity } from '../entities/review-response.entity';
import { ReviewsRepository } from '../repositories/reviews.repository';
import { roundRatingToOneDecimal, toReviewResponse } from '../utils/review-mapper.util';
import { ReviewEligibilityService } from './review-eligibility.service';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly reviewsRepository: ReviewsRepository,
    private readonly eligibilityService: ReviewEligibilityService,
  ) {}

  async create(customerId: string, dto: CreateReviewDto): Promise<ReviewResponseEntity> {
    const { vendorId } = await this.eligibilityService.assertEligible(
      customerId,
      dto.vendorOrderId,
      dto.productId,
    );

    let created: Review;
    try {
      created = await this.reviewsRepository.create({
        authorId: customerId,
        vendorId,
        productId: dto.productId,
        vendorOrderId: dto.vendorOrderId,
        rating: dto.rating,
        title: dto.title,
        body: dto.body,
      });
    } catch (error) {
      // The partial unique indexes enforce one review per purchase; a
      // duplicate (including a race between two simultaneous creates)
      // surfaces as a Postgres unique violation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already reviewed this purchase');
      }
      throw error;
    }

    return this.toResponseById(created.id);
  }

  async checkEligibility(
    customerId: string,
    vendorOrderId: string,
    productId?: string,
  ): Promise<ReviewEligibilityEntity> {
    const result = await this.eligibilityService.checkEligibility(customerId, vendorOrderId, productId);
    return { eligible: result.eligible, reason: result.reason };
  }

  async update(customerId: string, id: string, dto: UpdateReviewDto): Promise<ReviewResponseEntity> {
    const review = await this.getOwnedReview(customerId, id);
    if (review.moderationStatus !== 'VISIBLE') {
      throw new BadRequestException('A removed review cannot be edited - restore it first');
    }
    ReviewEligibilityService.assertWithinEditWindow(review.createdAt);

    await this.reviewsRepository.update(id, { rating: dto.rating, title: dto.title, body: dto.body });
    return this.toResponseById(id);
  }

  // Author-initiated removal is a soft delete (REMOVED_BY_AUTHOR), allowed
  // at any time. It does not free up a new review for the same purchase -
  // the partial unique index still holds the row.
  async softDelete(customerId: string, id: string): Promise<void> {
    const review = await this.getOwnedReview(customerId, id);
    if (review.moderationStatus === 'REMOVED_BY_ADMIN') {
      throw new ForbiddenException('This review was removed by an administrator and cannot be changed');
    }
    if (review.moderationStatus === 'REMOVED_BY_AUTHOR') {
      return;
    }
    await this.reviewsRepository.softDeleteByAuthor(id);
  }

  async restore(customerId: string, id: string): Promise<ReviewResponseEntity> {
    const review = await this.getOwnedReview(customerId, id);
    if (review.moderationStatus === 'REMOVED_BY_ADMIN') {
      throw new ForbiddenException('This review was removed by an administrator and cannot be restored');
    }
    if (review.moderationStatus === 'VISIBLE') {
      throw new BadRequestException('This review is already visible');
    }
    ReviewEligibilityService.assertWithinEditWindow(review.createdAt);

    await this.reviewsRepository.restore(id);
    return this.toResponseById(id);
  }

  async listByVendor(vendorId: string, dto: ListReviewsDto): Promise<PaginatedReviewsEntity> {
    const [{ items, total }, summary] = await Promise.all([
      this.reviewsRepository.listVisibleByVendor(vendorId, {
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
      }),
      this.reviewsRepository.getVendorRatingSummary(vendorId),
    ]);

    return {
      items: items.map(toReviewResponse),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
      averageRating: roundRatingToOneDecimal(summary.average),
    };
  }

  async listByProduct(productId: string, dto: ListReviewsDto): Promise<PaginatedReviewsEntity> {
    const [{ items, total }, summary] = await Promise.all([
      this.reviewsRepository.listVisibleByProduct(productId, {
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
      }),
      this.reviewsRepository.getProductRatingSummary(productId),
    ]);

    return {
      items: items.map(toReviewResponse),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
      averageRating: roundRatingToOneDecimal(summary.average),
    };
  }

  private async getOwnedReview(customerId: string, id: string): Promise<Review> {
    const review = await this.reviewsRepository.findById(id);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    if (review.authorId !== customerId) {
      throw new ForbiddenException('You can only manage your own reviews');
    }
    return review;
  }

  private async toResponseById(id: string): Promise<ReviewResponseEntity> {
    const review = await this.reviewsRepository.findPublicById(id);
    if (!review) {
      throw new NotFoundException('Review not found');
    }
    return toReviewResponse(review);
  }
}
