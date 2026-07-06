import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';
import { TemperatureReadingsRepository } from './temperature-readings.repository';

describe('TemperatureReadingsRepository', () => {
  let prisma: PrismaService;
  let repository: TemperatureReadingsRepository;
  let vendorUserId: string;
  let lotId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new TemperatureReadingsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const lotsRepository = new SeafoodLotsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const vendorUser = await usersRepository.create({
      email: `temp-readings-repo-vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    vendorUserId = vendorUser.id;

    const vendor = await vendorsRepository.create({
      userId: vendorUserId,
      businessName: "Vera's Catch",
      parish: 'KINGSTON',
      termsAcceptedAt: new Date(),
    });

    const lot = await lotsRepository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId: vendor.id,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 20,
      weightUnit: 'POUNDS',
    });
    lotId = lot.id;
  });

  afterAll(async () => {
    await prisma.temperatureReading.deleteMany({ where: { recordedById: vendorUserId } });
    await prisma.seafoodLot.deleteMany({ where: { id: lotId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a temperature reading', async () => {
    const reading = await repository.create({
      lotId,
      checkpoint: 'VENDOR_STORAGE',
      temperatureC: 2.5,
      recordedById: vendorUserId,
      latitude: 17.9714,
      longitude: -76.7931,
      photoUrl: 'https://cdn.example.com/reading.jpg',
    });

    expect(reading.lotId).toBe(lotId);
    expect(reading.checkpoint).toBe('VENDOR_STORAGE');
    expect(reading.temperatureC.toString()).toBe('2.5');
  });

  it('paginates readings for a lot', async () => {
    await repository.create({
      lotId,
      checkpoint: 'PACKING',
      temperatureC: 3,
      recordedById: vendorUserId,
    });

    const { items, total } = await repository.findByLotId(lotId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.lotId === lotId)).toBe(true);
  });

  it('returns an empty page for a lot with no readings', async () => {
    const { items, total } = await repository.findByLotId(randomUUID(), { skip: 0, take: 20 });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});
