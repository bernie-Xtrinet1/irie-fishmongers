import { Injectable, NotFoundException } from '@nestjs/common';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorProfileResponseEntity } from '../entities/vendor-profile-response.entity';
import { deriveVendorComplianceStatus } from '../utils/vendor-compliance-status.util';
import { VendorPermissionsService } from './vendor-permissions.service';

@Injectable()
export class VendorProfileService {
  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly vendorPermissionsService: VendorPermissionsService,
  ) {}

  async getProfile(vendorId: string): Promise<VendorProfileResponseEntity> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new NotFoundException('Vendor not found');
    }

    const [permissions, ordersCompleted] = await Promise.all([
      this.vendorPermissionsService.getPermissions(vendor.tier),
      this.vendorsRepository.countDeliveredOrders(vendor.id),
    ]);

    const complianceStatus = deriveVendorComplianceStatus(vendor.complianceScore);

    return {
      id: vendor.id,
      businessName: vendor.businessName,
      tier: vendor.tier,
      badge: permissions.badge,
      parish: vendor.parish,
      complianceScore: vendor.complianceScore,
      foodSafetyStatus: complianceStatus,
      traceabilityStatus: complianceStatus,
      ordersCompleted,
      rating: null,
      coldChainScore: null,
      recentReviews: [],
    };
  }
}
