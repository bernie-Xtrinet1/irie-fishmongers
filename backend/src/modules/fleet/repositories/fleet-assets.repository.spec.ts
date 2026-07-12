import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from './fleet-assets.repository';

describe('FleetAssetsRepository', () => {
  let prisma: PrismaService;
  let repository: FleetAssetsRepository;
  let zoneId: string;
  const licensePlate = `FL ${randomUUID().slice(0, 4)}`;
  let assetId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FleetAssetsRepository(prisma);
    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zoneId = zone.id;
  });

  afterAll(async () => {
    await prisma.fleetAsset.deleteMany({ where: { licensePlate } });
    await prisma.onModuleDestroy();
  });

  it('creates a fleet asset', async () => {
    const asset = await repository.create({
      zoneId,
      assetType: 'REFRIGERATED_TRUCK',
      ownership: 'COMPANY_OWNED',
      licensePlate,
      capacityLbs: 2000,
      coldChainCapable: true,
    });
    assetId = asset.id;

    expect(asset.status).toBe('ACTIVE');
    expect(asset.currentDriverId).toBeNull();
  });

  it('finds a fleet asset by id and by license plate', async () => {
    const byId = await repository.findById(assetId);
    expect(byId?.licensePlate).toBe(licensePlate);

    const byPlate = await repository.findByLicensePlate(licensePlate);
    expect(byPlate?.id).toBe(assetId);
  });

  it('returns null when a fleet asset cannot be found', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates a fleet asset status', async () => {
    const updated = await repository.update(assetId, { status: 'MAINTENANCE' });
    expect(updated.status).toBe('MAINTENANCE');
  });

  describe('findMany', () => {
    it('filters by zone and status and paginates', async () => {
      const { items, total } = await repository.findMany(
        { zoneId, status: 'MAINTENANCE' },
        { skip: 0, take: 20 },
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.some((item) => item.id === assetId)).toBe(true);
    });

    it('returns all assets when no filters are given', async () => {
      const { items } = await repository.findMany({}, { skip: 0, take: 20 });
      expect(items.some((item) => item.id === assetId)).toBe(true);
    });
  });

  describe('countByZoneAndStatus', () => {
    it('includes a group for this zone/status combination after the update above', async () => {
      const groups = await repository.countByZoneAndStatus();
      const group = groups.find((g) => g.zoneId === zoneId && g.status === 'MAINTENANCE');
      expect(group).toBeDefined();
      expect(group?.count).toBeGreaterThanOrEqual(1);
    });
  });
});
