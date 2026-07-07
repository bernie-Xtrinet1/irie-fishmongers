import { PrismaService } from '../../../database/prisma.service';
import { VendorTierConfigsRepository } from './vendor-tier-configs.repository';

// READ-ONLY tests against the real, seeded VendorTierConfig table (4 rows,
// one per VendorTier - see prisma/seed.ts's VENDOR_TIER_CONFIGS). This table
// has no vendorId/userId to scope test fixtures by, so - per this phase's
// test-isolation note in docs/database-design.md - this suite must never
// create, update, or delete rows here. It only asserts against the exact
// seeded values.
describe('VendorTierConfigsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorTierConfigsRepository;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorTierConfigsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  describe('findByTier', () => {
    it('returns the seeded config for COMMUNITY_FISHER', async () => {
      const config = await repository.findByTier('COMMUNITY_FISHER');

      expect(config).not.toBeNull();
      expect(config?.dailySalesLimit?.toString()).toBe('50000');
      expect(config?.monthlySalesLimit?.toString()).toBe('500000');
      expect(config?.maxActiveListings).toBe(50);
      expect(config?.badge).toBe('🐟 Community Fisher');
    });

    it('returns the seeded config for VERIFIED_VENDOR', async () => {
      const config = await repository.findByTier('VERIFIED_VENDOR');

      expect(config).not.toBeNull();
      expect(config?.dailySalesLimit).toBeNull();
      expect(config?.monthlySalesLimit).toBeNull();
      expect(config?.maxActiveListings).toBe(500);
      expect(config?.badge).toBe('✓ Verified Vendor');
    });

    it('returns the seeded config for COMMERCIAL_SUPPLIER', async () => {
      const config = await repository.findByTier('COMMERCIAL_SUPPLIER');

      expect(config).not.toBeNull();
      expect(config?.dailySalesLimit).toBeNull();
      expect(config?.monthlySalesLimit).toBeNull();
      expect(config?.maxActiveListings).toBeNull();
      expect(config?.badge).toBe('✓ Commercial Supplier');
    });

    it('returns the seeded config for ENTERPRISE_SUPPLIER with unlimited listings', async () => {
      const config = await repository.findByTier('ENTERPRISE_SUPPLIER');

      expect(config).not.toBeNull();
      expect(config?.dailySalesLimit).toBeNull();
      expect(config?.monthlySalesLimit).toBeNull();
      expect(config?.maxActiveListings).toBeNull();
      expect(config?.badge).toBe('✓ Enterprise Supplier');
    });
  });

  describe('findAll', () => {
    it('returns exactly the 4 seeded tier configs ordered by tier', async () => {
      const configs = await repository.findAll();

      expect(configs).toHaveLength(4);
      expect(configs.map((config) => config.tier)).toEqual([
        'COMMUNITY_FISHER',
        'VERIFIED_VENDOR',
        'COMMERCIAL_SUPPLIER',
        'ENTERPRISE_SUPPLIER',
      ]);
    });
  });
});
