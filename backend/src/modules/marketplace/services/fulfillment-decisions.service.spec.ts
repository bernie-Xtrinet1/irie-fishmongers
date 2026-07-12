import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MarketplaceModeConfig, VendorSelectionWeightConfig } from '@prisma/client';

import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { FulfillmentCandidatesRepository, ProductCandidate } from '../repositories/fulfillment-candidates.repository';
import { FulfillmentDecisionsRepository } from '../repositories/fulfillment-decisions.repository';
import { MarketplaceModeConfigsRepository } from '../repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from '../repositories/vendor-selection-weight-configs.repository';
import { FulfillmentDecisionsService } from './fulfillment-decisions.service';
import { VendorSelectionEngineService } from './vendor-selection-engine.service';

function buildDecimal(value: number) {
  return { toNumber: () => value, toString: () => value.toString() } as unknown as VendorSelectionWeightConfig['inventoryWeight'];
}

function buildModeConfig(overrides: Partial<MarketplaceModeConfig> = {}): MarketplaceModeConfig {
  return {
    id: 'mode-config-1',
    customerSelectedEnabled: true,
    bestAvailableEnabled: true,
    updatedById: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildWeightConfig(): VendorSelectionWeightConfig {
  return {
    id: 'weight-config-1',
    inventoryWeight: buildDecimal(0.3),
    freshnessWeight: buildDecimal(0.2),
    complianceWeight: buildDecimal(0.2),
    distanceWeight: buildDecimal(0.15),
    ratingWeight: buildDecimal(0.05),
    deliveryCapacityWeight: buildDecimal(0.1),
    updatedById: null,
    createdAt: new Date(),
  };
}

function buildCandidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    lotId: null,
    name: 'Fresh Snapper',
    description: 'desc',
    unit: 'PER_POUND',
    price: buildDecimal(850),
    currency: 'JMD',
    quantityAvailable: 20,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
    weightLbs: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lot: null,
    vendor: {
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
      termsAcceptedAt: new Date(),
      primaryZoneId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

describe('FulfillmentDecisionsService', () => {
  let candidatesRepository: jest.Mocked<Pick<FulfillmentCandidatesRepository, 'findById' | 'findMatchingCandidates'>>;
  let decisionsRepository: jest.Mocked<Pick<FulfillmentDecisionsRepository, 'createDecisionWithScores'>>;
  let modeConfigsRepository: jest.Mocked<Pick<MarketplaceModeConfigsRepository, 'findCurrent'>>;
  let weightConfigsRepository: jest.Mocked<Pick<VendorSelectionWeightConfigsRepository, 'findCurrent'>>;
  let vendorPermissionsService: jest.Mocked<Pick<VendorPermissionsService, 'getPermissions'>>;
  let service: FulfillmentDecisionsService;

  const dto = { productId: 'product-1', quantity: 5, deliveryParish: 'KINGSTON' as const };

  beforeEach(() => {
    candidatesRepository = { findById: jest.fn(), findMatchingCandidates: jest.fn() };
    decisionsRepository = { createDecisionWithScores: jest.fn().mockResolvedValue('decision-1') };
    modeConfigsRepository = { findCurrent: jest.fn().mockResolvedValue(buildModeConfig()) };
    weightConfigsRepository = { findCurrent: jest.fn().mockResolvedValue(buildWeightConfig()) };
    vendorPermissionsService = {
      getPermissions: jest.fn().mockResolvedValue({
        tier: 'COMMUNITY_FISHER',
        badge: '🐟 Community Fisher',
        dailySalesLimit: null,
        monthlySalesLimit: null,
        maxActiveListings: null,
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
      }),
    };

    service = new FulfillmentDecisionsService(
      candidatesRepository as unknown as FulfillmentCandidatesRepository,
      decisionsRepository as unknown as FulfillmentDecisionsRepository,
      modeConfigsRepository as unknown as MarketplaceModeConfigsRepository,
      weightConfigsRepository as unknown as VendorSelectionWeightConfigsRepository,
      new VendorSelectionEngineService(),
      vendorPermissionsService as unknown as VendorPermissionsService,
    );
  });

  it('throws when Best Available Vendor mode is disabled', async () => {
    modeConfigsRepository.findCurrent.mockResolvedValue(buildModeConfig({ bestAvailableEnabled: false }));

    await expect(service.resolveBestVendor('customer-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(candidatesRepository.findById).not.toHaveBeenCalled();
  });

  it('throws when the requested product does not exist', async () => {
    candidatesRepository.findById.mockResolvedValue(null);

    await expect(service.resolveBestVendor('customer-1', dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists the decision and throws when no candidate is eligible', async () => {
    candidatesRepository.findById.mockResolvedValue(buildCandidate());
    candidatesRepository.findMatchingCandidates.mockResolvedValue([
      buildCandidate({ vendor: { ...buildCandidate().vendor, status: 'PENDING' } }),
    ]);

    await expect(service.resolveBestVendor('customer-1', dto)).rejects.toBeInstanceOf(NotFoundException);

    expect(decisionsRepository.createDecisionWithScores).toHaveBeenCalledWith(
      expect.objectContaining({ requestedProductId: 'product-1', quantity: 5, customerId: 'customer-1' }),
      expect.arrayContaining([expect.objectContaining({ eligible: false })]),
      null,
    );
  });

  it('resolves the winning vendor and persists the assignment', async () => {
    const requested = buildCandidate();
    candidatesRepository.findById.mockResolvedValue(requested);
    candidatesRepository.findMatchingCandidates.mockResolvedValue([requested]);

    const result = await service.resolveBestVendor('customer-1', dto);

    expect(result.vendorId).toBe('vendor-1');
    expect(result.productId).toBe('product-1');
    expect(result.badge).toBe('🐟 Community Fisher');
    expect(result.fulfillmentDecisionId).toBe('decision-1');
    expect(decisionsRepository.createDecisionWithScores).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      { vendorId: 'vendor-1', productId: 'product-1' },
    );
  });

  it('picks the higher-scoring vendor among multiple eligible candidates', async () => {
    const requested = buildCandidate();
    const strongerCandidate = buildCandidate({
      id: 'product-2',
      vendorId: 'vendor-2',
      vendor: { ...requested.vendor, id: 'vendor-2', complianceScore: 95 },
    });
    candidatesRepository.findById.mockResolvedValue(requested);
    candidatesRepository.findMatchingCandidates.mockResolvedValue([requested, strongerCandidate]);

    const result = await service.resolveBestVendor('customer-1', dto);

    expect(result.vendorId).toBe('vendor-2');
  });
});
