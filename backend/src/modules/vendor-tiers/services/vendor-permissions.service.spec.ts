import { ForbiddenException } from '@nestjs/common';
import { VendorTierConfig, VendorTierFeature } from '@prisma/client';

import { VendorSalesRepository } from '../repositories/vendor-sales.repository';
import { VendorTierConfigsRepository } from '../repositories/vendor-tier-configs.repository';
import { VendorTierFeaturesRepository } from '../repositories/vendor-tier-features.repository';
import { VendorPermissionsService } from './vendor-permissions.service';

function buildDecimal(value: number): VendorTierConfig['dailySalesLimit'] {
  return {
    toNumber: () => value,
    toString: () => value.toString(),
  } as unknown as VendorTierConfig['dailySalesLimit'];
}

function buildConfig(overrides: Partial<VendorTierConfig> = {}): VendorTierConfig {
  return {
    id: 'config-1',
    tier: 'COMMUNITY_FISHER',
    dailySalesLimit: buildDecimal(50000),
    monthlySalesLimit: buildDecimal(500000),
    maxActiveListings: 50,
    badge: '🐟 Community Fisher',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildFeature(overrides: Partial<VendorTierFeature> = {}): VendorTierFeature {
  return {
    id: 'feature-1',
    tier: 'COMMUNITY_FISHER',
    feature: 'SELL_RETAIL',
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('VendorPermissionsService', () => {
  let configsRepository: jest.Mocked<Pick<VendorTierConfigsRepository, 'findByTier'>>;
  let featuresRepository: jest.Mocked<Pick<VendorTierFeaturesRepository, 'findByTier'>>;
  let salesRepository: jest.Mocked<
    Pick<VendorSalesRepository, 'countActiveListings' | 'sumVendorOrderSubtotalsSince'>
  >;
  let service: VendorPermissionsService;

  beforeEach(() => {
    configsRepository = { findByTier: jest.fn() };
    featuresRepository = { findByTier: jest.fn() };
    salesRepository = {
      countActiveListings: jest.fn(),
      sumVendorOrderSubtotalsSince: jest.fn(),
    };
    service = new VendorPermissionsService(
      configsRepository as unknown as VendorTierConfigsRepository,
      featuresRepository as unknown as VendorTierFeaturesRepository,
      salesRepository as unknown as VendorSalesRepository,
    );
  });

  describe('getPermissions', () => {
    it('computes all 10 canX flags from VendorTierFeature rows', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig());
      featuresRepository.findByTier.mockResolvedValue([
        buildFeature({ feature: 'SELL_RETAIL', enabled: true }),
        buildFeature({ feature: 'SELL_WHOLESALE', enabled: false }),
        buildFeature({ feature: 'ACCEPT_HOTEL_ORDERS', enabled: true }),
        buildFeature({ feature: 'ACCEPT_RESTAURANT_ORDERS', enabled: false }),
        buildFeature({ feature: 'ACCEPT_GOVERNMENT_ORDERS', enabled: true }),
        buildFeature({ feature: 'EXPORT_PRODUCTS', enabled: false }),
        buildFeature({ feature: 'ACCESS_ANALYTICS', enabled: true }),
        buildFeature({ feature: 'ACCESS_PROMOTIONS', enabled: false }),
        buildFeature({ feature: 'API_ACCESS', enabled: true }),
        buildFeature({ feature: 'MULTI_ZONE_OPERATIONS', enabled: false }),
      ]);

      const result = await service.getPermissions('COMMUNITY_FISHER');

      expect(result).toEqual({
        tier: 'COMMUNITY_FISHER',
        badge: '🐟 Community Fisher',
        dailySalesLimit: '50000',
        monthlySalesLimit: '500000',
        maxActiveListings: 50,
        canSellRetail: true,
        canSellWholesale: false,
        canAcceptHotelOrders: true,
        canAcceptRestaurantOrders: false,
        canAcceptGovernmentOrders: true,
        canExportProducts: false,
        canAccessAnalytics: true,
        canAccessPromotions: false,
        canUseApiAccess: true,
        canOperateMultipleZones: false,
      });
    });

    it('defaults missing feature rows to false', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig());
      featuresRepository.findByTier.mockResolvedValue([]);

      const result = await service.getPermissions('COMMUNITY_FISHER');

      expect(result.canSellRetail).toBe(false);
      expect(result.canSellWholesale).toBe(false);
      expect(result.canAcceptHotelOrders).toBe(false);
      expect(result.canAcceptRestaurantOrders).toBe(false);
      expect(result.canAcceptGovernmentOrders).toBe(false);
      expect(result.canExportProducts).toBe(false);
      expect(result.canAccessAnalytics).toBe(false);
      expect(result.canAccessPromotions).toBe(false);
      expect(result.canUseApiAccess).toBe(false);
      expect(result.canOperateMultipleZones).toBe(false);
    });

    it('defaults badge to empty string and limits to null when no config exists', async () => {
      configsRepository.findByTier.mockResolvedValue(null);
      featuresRepository.findByTier.mockResolvedValue([]);

      const result = await service.getPermissions('ENTERPRISE_SUPPLIER');

      expect(result.badge).toBe('');
      expect(result.dailySalesLimit).toBeNull();
      expect(result.monthlySalesLimit).toBeNull();
      expect(result.maxActiveListings).toBeNull();
    });

    it('returns null sales limits when the config has null limits', async () => {
      configsRepository.findByTier.mockResolvedValue(
        buildConfig({ dailySalesLimit: null, monthlySalesLimit: null, maxActiveListings: null }),
      );
      featuresRepository.findByTier.mockResolvedValue([]);

      const result = await service.getPermissions('COMMERCIAL_SUPPLIER');

      expect(result.dailySalesLimit).toBeNull();
      expect(result.monthlySalesLimit).toBeNull();
      expect(result.maxActiveListings).toBeNull();
    });
  });

  describe('assertListingLimitNotExceeded', () => {
    it('does not throw and does not query active listings when maxActiveListings is null', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig({ maxActiveListings: null }));

      await expect(
        service.assertListingLimitNotExceeded('vendor-1', 'COMMERCIAL_SUPPLIER'),
      ).resolves.toBeUndefined();
      expect(salesRepository.countActiveListings).not.toHaveBeenCalled();
    });

    it('does not throw and does not query active listings when no config exists', async () => {
      configsRepository.findByTier.mockResolvedValue(null);

      await expect(
        service.assertListingLimitNotExceeded('vendor-1', 'ENTERPRISE_SUPPLIER'),
      ).resolves.toBeUndefined();
      expect(salesRepository.countActiveListings).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the active listing count is at the limit', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig({ maxActiveListings: 50 }));
      salesRepository.countActiveListings.mockResolvedValue(50);

      await expect(
        service.assertListingLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when the active listing count exceeds the limit', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig({ maxActiveListings: 50 }));
      salesRepository.countActiveListings.mockResolvedValue(51);

      await expect(
        service.assertListingLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not throw when the active listing count is under the limit', async () => {
      configsRepository.findByTier.mockResolvedValue(buildConfig({ maxActiveListings: 50 }));
      salesRepository.countActiveListings.mockResolvedValue(49);

      await expect(
        service.assertListingLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER'),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertSalesLimitNotExceeded', () => {
    it('does not throw and does not query sales when no config exists', async () => {
      configsRepository.findByTier.mockResolvedValue(null);

      await expect(
        service.assertSalesLimitNotExceeded('vendor-1', 'ENTERPRISE_SUPPLIER', 1000),
      ).resolves.toBeUndefined();
      expect(salesRepository.sumVendorOrderSubtotalsSince).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the daily limit would be exceeded', async () => {
      configsRepository.findByTier.mockResolvedValue(
        buildConfig({
          dailySalesLimit: buildDecimal(50000),
          monthlySalesLimit: null,
        }),
      );
      salesRepository.sumVendorOrderSubtotalsSince.mockResolvedValue(49000);

      await expect(
        service.assertSalesLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER', 2000),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when the monthly limit would be exceeded, independent of a null daily limit', async () => {
      configsRepository.findByTier.mockResolvedValue(
        buildConfig({
          dailySalesLimit: null,
          monthlySalesLimit: buildDecimal(500000),
        }),
      );
      salesRepository.sumVendorOrderSubtotalsSince.mockResolvedValue(499000);

      await expect(
        service.assertSalesLimitNotExceeded('vendor-1', 'VERIFIED_VENDOR', 2000),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checks both daily and monthly limits independently when both are configured', async () => {
      configsRepository.findByTier.mockResolvedValue(
        buildConfig({
          dailySalesLimit: buildDecimal(50000),
          monthlySalesLimit: buildDecimal(500000),
        }),
      );
      salesRepository.sumVendorOrderSubtotalsSince.mockResolvedValue(1000);

      await expect(
        service.assertSalesLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER', 500),
      ).resolves.toBeUndefined();
      expect(salesRepository.sumVendorOrderSubtotalsSince).toHaveBeenCalledTimes(2);
    });

    it('does not throw when both amounts are within their limits', async () => {
      configsRepository.findByTier.mockResolvedValue(
        buildConfig({
          dailySalesLimit: buildDecimal(50000),
          monthlySalesLimit: buildDecimal(500000),
        }),
      );
      salesRepository.sumVendorOrderSubtotalsSince.mockResolvedValue(0);

      await expect(
        service.assertSalesLimitNotExceeded('vendor-1', 'COMMUNITY_FISHER', 100),
      ).resolves.toBeUndefined();
    });
  });
});
