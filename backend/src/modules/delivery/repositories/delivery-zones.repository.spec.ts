import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { DeliveryZonesRepository } from './delivery-zones.repository';

describe('DeliveryZonesRepository', () => {
  let prisma: PrismaService;
  let repository: DeliveryZonesRepository;
  let zoneId: string;
  const code = `ZONE_TEST_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DeliveryZonesRepository(prisma);
  });

  afterAll(async () => {
    await prisma.deliveryZone.deleteMany({ where: { code } });
    await prisma.onModuleDestroy();
  });

  it('creates a delivery zone', async () => {
    const zone = await repository.create({ name: 'Repo Test Zone', code, description: 'test' });
    zoneId = zone.id;
    expect(zone.active).toBe(true);
    expect(zone.code).toBe(code);
  });

  it('finds a zone by id and by code', async () => {
    const byId = await repository.findById(zoneId);
    expect(byId?.code).toBe(code);

    const byCode = await repository.findByCode(code);
    expect(byCode?.id).toBe(zoneId);
  });

  it('updates a delivery zone', async () => {
    const updated = await repository.update(zoneId, { active: false });
    expect(updated.active).toBe(false);
  });

  it('lists zones, optionally filtered to active only', async () => {
    const all = await repository.findAll(false);
    expect(all.some((zone) => zone.id === zoneId)).toBe(true);

    const activeOnly = await repository.findAll(true);
    expect(activeOnly.some((zone) => zone.id === zoneId)).toBe(false);
  });

  it('resolves the zone id seeded for a parish', async () => {
    // jamaica-delivery-zones.md seeds every parish with a zone mapping.
    const zoneIdForKingston = await repository.findZoneIdForParish('KINGSTON');
    expect(zoneIdForKingston).not.toBeNull();
  });
});
