import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { FleetAssetsRepository } from './fleet-assets.repository';
import { FleetSanitationRecordsRepository } from './fleet-sanitation-records.repository';

describe('FleetSanitationRecordsRepository', () => {
  let prisma: PrismaService;
  let repository: FleetSanitationRecordsRepository;
  let fleetAssetsRepository: FleetAssetsRepository;
  let fleetAssetId: string;
  const licensePlate = `SN ${randomUUID().slice(0, 4)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FleetSanitationRecordsRepository(prisma);
    fleetAssetsRepository = new FleetAssetsRepository(prisma);

    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    const fleetAsset = await fleetAssetsRepository.create({
      zoneId: zone.id,
      assetType: 'REFRIGERATED_TRUCK',
      ownership: 'COMPANY_OWNED',
      licensePlate,
      capacityLbs: 2000,
      coldChainCapable: true,
    });
    fleetAssetId = fleetAsset.id;
  });

  afterAll(async () => {
    await prisma.fleetSanitationRecord.deleteMany({ where: { fleetAssetId } });
    await prisma.fleetAsset.deleteMany({ where: { id: fleetAssetId } });
    await prisma.onModuleDestroy();
  });

  it('creates a sanitation record', async () => {
    const record = await repository.create({
      fleetAssetId,
      performedAt: new Date('2026-07-08T00:00:00.000Z'),
      performedBy: 'Sanitation Crew A',
      method: 'Chlorine wash',
    });

    expect(record.status).toBe('COMPLETED');
    expect(record.fleetAssetId).toBe(fleetAssetId);
  });

  it('finds all sanitation records for a fleet asset', async () => {
    await repository.create({
      fleetAssetId,
      performedAt: new Date('2026-07-09T00:00:00.000Z'),
    });

    const { items, total } = await repository.findByFleetAssetId(fleetAssetId, {
      skip: 0,
      take: 20,
    });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.fleetAssetId === fleetAssetId)).toBe(true);
  });
});
