import { Injectable } from '@nestjs/common';

import { ReviewResponseEntity } from '../entities/review-response.entity';
import { ReviewsRepository } from '../repositories/reviews.repository';
import { roundRatingToOneDecimal, toReviewResponse } from '../utils/review-mapper.util';

export interface VendorRatingSummary {
  averageRating: number | null;
  reviewCount: number;
}

export interface ProductRatingSummary {
  averageRating: number | null;
  reviewCount: number;
}

// The ONLY service ReviewsModule exports. Other modules (ProductsModule,
// VendorTiersModule in 13E) depend on this narrow read-only surface rather
// than the whole ReviewsModule, keeping the dependency graph acyclic. All
// averages are pre-rounded to one decimal place here.
@Injectable()
export class ReviewsQueryService {
  private static readonly RECENT_REVIEWS_LIMIT = 5;

  constructor(private readonly reviewsRepository: ReviewsRepository) {}

  async getVendorRatingSummary(vendorId: string): Promise<VendorRatingSummary> {
    const { average, count } = await this.reviewsRepository.getVendorRatingSummary(vendorId);
    return { averageRating: roundRatingToOneDecimal(average), reviewCount: count };
  }

  async getProductRatingSummary(productId: string): Promise<ProductRatingSummary> {
    const { average, count } = await this.reviewsRepository.getProductRatingSummary(productId);
    return { averageRating: roundRatingToOneDecimal(average), reviewCount: count };
  }

  async getRecentVendorReviews(vendorId: string): Promise<ReviewResponseEntity[]> {
    const reviews = await this.reviewsRepository.listRecentVisibleByVendor(
      vendorId,
      ReviewsQueryService.RECENT_REVIEWS_LIMIT,
    );
    return reviews.map(toReviewResponse);
  }
}
