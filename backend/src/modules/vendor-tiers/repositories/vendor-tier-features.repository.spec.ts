import { VendorTierFeature } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { VendorTierFeaturesRepository } from './vendor-tier-features.repository';

// READ-ONLY tests against the real, seeded VendorTierFeature table (4 tiers
// x 10 feature flags = 40 rows - see prisma/seed.ts's VENDOR_TIER_FEATURES).
// Same test-isolation constraint as vendor-tier-configs.repository.spec.ts:
// this table has no vendorId/userId to scope by, so this suite must never
// create, update, or delete rows here.
describe('VendorTierFeaturesRepository', () => {
  let prisma: PrismaService;
  let repository: VendorTierFeaturesRepository;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorTierFeaturesRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const enabledMap = (features: VendorTierFeature[]): Record<string, boolean> =>
    Object.fromEntries(features.map((feature) => [feature.feature, feature.enabled]));

  describe('findByTier', () => {
    it('returns exactly 10 seeded feature flags for COMMUNITY_FISHER', async () => {
      const features = await repository.findByTier('COMMUNITY_FISHER');

      expect(features).toHaveLength(10);
      expect(enabledMap(features)).toEqual({
        SELL_RETAIL: true,
        SELL_WHOLESALE: false,
        ACCEPT_HOTEL_ORDERS: false,
        ACCEPT_RESTAURANT_ORDERS: false,
        ACCEPT_GOVERNMENT_ORDERS: false,
        EXPORT_PRODUCTS: false,
        ACCESS_ANALYTICS: false,
        ACCESS_PROMOTIONS: false,
        API_ACCESS: false,
        MULTI_ZONE_OPERATIONS: false,
      });
    });

    it('returns exactly 10 seeded feature flags for VERIFIED_VENDOR', async () => {
      const features = await repository.findByTier('VERIFIED_VENDOR');

      expect(features).toHaveLength(10);
      expect(enabledMap(features)).toEqual({
        SELL_RETAIL: true,
        SELL_WHOLESALE: false,
        ACCEPT_HOTEL_ORDERS: false,
        ACCEPT_RESTAURANT_ORDERS: false,
        ACCEPT_GOVERNMENT_ORDERS: false,
        EXPORT_PRODUCTS: false,
        ACCESS_ANALYTICS: true,
        ACCESS_PROMOTIONS: true,
        API_ACCESS: false,
        MULTI_ZONE_OPERATIONS: false,
      });
    });

    it('returns exactly 10 seeded feature flags for COMMERCIAL_SUPPLIER', async () => {
      const features = await repository.findByTier('COMMERCIAL_SUPPLIER');

      expect(features).toHaveLength(10);
      expect(enabledMap(features)).toEqual({
        SELL_RETAIL: true,
        SELL_WHOLESALE: true,
        ACCEPT_HOTEL_ORDERS: true,
        ACCEPT_RESTAURANT_ORDERS: true,
        ACCEPT_GOVERNMENT_ORDERS: true,
        EXPORT_PRODUCTS: false,
        ACCESS_ANALYTICS: true,
        ACCESS_PROMOTIONS: true,
        API_ACCESS: false,
        MULTI_ZONE_OPERATIONS: false,
      });
    });

    it('returns exactly 10 seeded feature flags for ENTERPRISE_SUPPLIER, all enabled', async () => {
      const features = await repository.findByTier('ENTERPRISE_SUPPLIER');

      expect(features).toHaveLength(10);
      expect(features.every((feature) => feature.enabled)).toBe(true);
    });
  });
});
