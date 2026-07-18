import { NotFoundException } from '@nestjs/common';
import { Vendor } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorPermissionsEntity } from '../entities/vendor-permissions.entity';
import { VendorPermissionsService } from './vendor-permissions.service';
import { VendorProfileService } from './vendor-profile.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    complianceScoreUpdatedAt: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildPermissions(overrides: Partial<VendorPermissionsEntity> = {}): VendorPermissionsEntity {
  return {
    tier: 'COMMUNITY_FISHER',
    badge: '🐟 Community Fisher',
    dailySalesLimit: '50000',
    monthlySalesLimit: '500000',
    maxActiveListings: 50,
    canSellRetail: true,
    canSellWholesale: false,
    canAcceptHotelOrders: false,
    canAcceptRestaurantOrders: false,
    canAcceptGovernmentOrders: false,
    canExportProducts: false,
    canAccessAnalytics: false,
    canAccessPromotions: false,
    canUseApiAccess: false,
    canOperateMultipleZones: false,
    ...overrides,
  };
}

describe('VendorProfileService', () => {
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById' | 'countDeliveredOrders'>>;
  let vendorPermissionsService: jest.Mocked<Pick<VendorPermissionsService, 'getPermissions'>>;
  let service: VendorProfileService;

  beforeEach(() => {
    vendorsRepository = { findById: jest.fn(), countDeliveredOrders: jest.fn() };
    vendorPermissionsService = { getPermissions: jest.fn() };
    service = new VendorProfileService(
      vendorsRepository as unknown as VendorsRepository,
      vendorPermissionsService as unknown as VendorPermissionsService,
    );
  });

  it('returns a profile with a neutral rating/coldChainScore and empty reviews', async () => {
    vendorsRepository.findById.mockResolvedValue(buildVendor());
    vendorsRepository.countDeliveredOrders.mockResolvedValue(12);
    vendorPermissionsService.getPermissions.mockResolvedValue(buildPermissions());

    const result = await service.getProfile('vendor-1');

    expect(result.badge).toBe('🐟 Community Fisher');
    expect(result.ordersCompleted).toBe(12);
    expect(result.rating).toBeNull();
    expect(result.coldChainScore).toBeNull();
    expect(result.recentReviews).toEqual([]);
    expect(result.foodSafetyStatus).toBe('NOT_YET_ASSESSED');
  });

  it('derives COMPLIANT status when the score is at or above 80', async () => {
    vendorsRepository.findById.mockResolvedValue(buildVendor({ complianceScore: 85 }));
    vendorsRepository.countDeliveredOrders.mockResolvedValue(0);
    vendorPermissionsService.getPermissions.mockResolvedValue(buildPermissions());

    const result = await service.getProfile('vendor-1');
    expect(result.foodSafetyStatus).toBe('COMPLIANT');
    expect(result.traceabilityStatus).toBe('COMPLIANT');
  });

  it('derives AT_RISK status when the score is between 50 and 79', async () => {
    vendorsRepository.findById.mockResolvedValue(buildVendor({ complianceScore: 60 }));
    vendorsRepository.countDeliveredOrders.mockResolvedValue(0);
    vendorPermissionsService.getPermissions.mockResolvedValue(buildPermissions());

    const result = await service.getProfile('vendor-1');
    expect(result.foodSafetyStatus).toBe('AT_RISK');
  });

  it('derives NON_COMPLIANT status when the score is below 50', async () => {
    vendorsRepository.findById.mockResolvedValue(buildVendor({ complianceScore: 20 }));
    vendorsRepository.countDeliveredOrders.mockResolvedValue(0);
    vendorPermissionsService.getPermissions.mockResolvedValue(buildPermissions());

    const result = await service.getProfile('vendor-1');
    expect(result.foodSafetyStatus).toBe('NON_COMPLIANT');
  });

  it('throws when the vendor does not exist', async () => {
    vendorsRepository.findById.mockResolvedValue(null);
    await expect(service.getProfile('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws when the vendor is not approved', async () => {
    vendorsRepository.findById.mockResolvedValue(buildVendor({ status: 'PENDING' }));
    await expect(service.getProfile('vendor-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
