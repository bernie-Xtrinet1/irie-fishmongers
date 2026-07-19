import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from './fleet-assets.repository';
import { FleetMaintenanceRepository } from './fleet-maintenance.repository';

describe('FleetMaintenanceRepository', () => {
  let prisma: PrismaService;
  let repository: FleetMaintenanceRepository;
  let fleetAssetsRepository: FleetAssetsRepository;
  let fleetAssetId: string;
  const licensePlate = `MT ${randomUUID().slice(0, 4)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FleetMaintenanceRepository(prisma);
    fleetAssetsRepository = new FleetAssetsRepository(prisma);

    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    const fleetAsset = await fleetAssetsRepository.create({
      zoneId: zone.id,
      assetType: 'VAN',
      ownership: 'COMPANY_OWNED',
      licensePlate,
      capacityLbs: 800,
    });
    fleetAssetId = fleetAsset.id;
  });

  afterAll(async () => {
    await prisma.fleetMaintenance.deleteMany({ where: { fleetAssetId } });
    await prisma.fleetAsset.deleteMany({ where: { id: fleetAssetId } });
    await prisma.onModuleDestroy();
  });

  it('creates a maintenance record', async () => {
    const record = await repository.create({
      fleetAssetId,
      serviceDate: new Date('2026-07-08T00:00:00.000Z'),
      mileage: 50000,
      technician: 'Joe Mechanic',
    });

    expect(record.status).toBe('SCHEDULED');
    expect(record.fleetAssetId).toBe(fleetAssetId);
  });

  it('finds a maintenance record by id', async () => {
    const created = await repository.create({
      fleetAssetId,
      serviceDate: new Date('2026-07-09T00:00:00.000Z'),
    });
    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when a maintenance record cannot be found', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates a maintenance record', async () => {
    const created = await repository.create({
      fleetAssetId,
      serviceDate: new Date('2026-07-10T00:00:00.000Z'),
    });
    const updated = await repository.update(created.id, { status: 'COMPLETED', cost: 5000 });
    expect(updated.status).toBe('COMPLETED');
    expect(updated.cost?.toNumber()).toBe(5000);
  });

  it('finds all maintenance records for a fleet asset', async () => {
    const { items, total } = await repository.findByFleetAssetId(fleetAssetId, {
      skip: 0,
      take: 20,
    });
    expect(total).toBeGreaterThanOrEqual(3);
    expect(items.every((item) => item.fleetAssetId === fleetAssetId)).toBe(true);
  });
});
