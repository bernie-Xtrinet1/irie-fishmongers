import { Injectable, NotFoundException } from '@nestjs/common';

import { ReviewsQueryService } from '../../reviews/services/reviews-query.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorProfileResponseEntity } from '../entities/vendor-profile-response.entity';
import { deriveComplianceBand } from '../utils/compliance-score-band.util';
import { deriveVendorComplianceStatus } from '../utils/vendor-compliance-status.util';
import { VendorPermissionsService } from './vendor-permissions.service';

@Injectable()
export class VendorProfileService {
  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly vendorPermissionsService: VendorPermissionsService,
    private readonly reviewsQueryService: ReviewsQueryService,
  ) {}

  async getProfile(vendorId: string): Promise<VendorProfileResponseEntity> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new NotFoundException('Vendor not found');
    }

    const [permissions, ordersCompleted, ratingSummary, recentReviews] = await Promise.all([
      this.vendorPermissionsService.getPermissions(vendor.tier),
      this.vendorsRepository.countDeliveredOrders(vendor.id),
      this.reviewsQueryService.getVendorRatingSummary(vendor.id),
      this.reviewsQueryService.getRecentVendorReviews(vendor.id),
    ]);

    const complianceStatus = deriveVendorComplianceStatus(vendor.complianceScore);

    return {
      id: vendor.id,
      businessName: vendor.businessName,
      tier: vendor.tier,
      badge: permissions.badge,
      parish: vendor.parish,
      complianceScore: vendor.complianceScore,
      complianceBand: deriveComplianceBand(vendor.complianceScore),
      complianceScoreUpdatedAt: vendor.complianceScoreUpdatedAt,
      foodSafetyStatus: complianceStatus,
      traceabilityStatus: complianceStatus,
      ordersCompleted,
      rating: ratingSummary.averageRating,
      coldChainScore: null,
      recentReviews,
    };
  }
}
