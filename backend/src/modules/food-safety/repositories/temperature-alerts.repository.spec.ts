import { randomUUID } from 'crypto';

import { Role, RoleName, TemperatureReading } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';
import { TemperatureAlertsRepository } from './temperature-alerts.repository';
import { TemperatureReadingsRepository } from './temperature-readings.repository';

describe('TemperatureAlertsRepository', () => {
  let prisma: PrismaService;
  let repository: TemperatureAlertsRepository;
  let readingsRepository: TemperatureReadingsRepository;
  let vendorUserId: string;
  let lotId: string;

  async function createReading(): Promise<TemperatureReading> {
    return readingsRepository.create({
      lotId,
      checkpoint: 'IN_TRANSIT',
      temperatureC: 9,
      recordedById: vendorUserId,
    });
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new TemperatureAlertsRepository(prisma);
    readingsRepository = new TemperatureReadingsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const lotsRepository = new SeafoodLotsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const vendorUser = await usersRepository.create({
      email: `temp-alerts-repo-vendor-${randomUUID()}@example.com`,
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
    await prisma.temperatureAlert.deleteMany({ where: { lotId } });
    await prisma.temperatureReading.deleteMany({ where: { recordedById: vendorUserId } });
    await prisma.seafoodLot.deleteMany({ where: { id: lotId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a temperature alert', async () => {
    const reading = await createReading();
    const alert = await repository.create({
      readingId: reading.id,
      lotId,
      severity: 'WARNING',
      actualC: 9,
    });

    expect(alert.readingId).toBe(reading.id);
    expect(alert.severity).toBe('WARNING');
    expect(alert.resolved).toBe(false);
  });

  it('finds an alert by id and returns null when missing', async () => {
    const reading = await createReading();
    const created = await repository.create({
      readingId: reading.id,
      lotId,
      severity: 'CRITICAL',
      actualC: 12,
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);

    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('resolves an alert', async () => {
    const reading = await createReading();
    const created = await repository.create({
      readingId: reading.id,
      lotId,
      severity: 'WARNING',
      actualC: 8,
    });

    const resolved = await repository.resolve(created.id);
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('counts unresolved alerts for a lot', async () => {
    const countBefore = await repository.countUnresolvedByLotId(lotId);

    const reading = await createReading();
    await repository.create({
      readingId: reading.id,
      lotId,
      severity: 'CRITICAL',
      actualC: 15,
    });

    const countAfter = await repository.countUnresolvedByLotId(lotId);
    expect(countAfter).toBe(countBefore + 1);
  });

  describe('findMany', () => {
    it('filters by severity and resolved', async () => {
      const reading = await createReading();
      const created = await repository.create({
        readingId: reading.id,
        lotId,
        severity: 'EMERGENCY',
        actualC: 20,
      });
      await repository.resolve(created.id);

      const { items, total } = await repository.findMany(
        { severity: 'EMERGENCY', resolved: true },
        { skip: 0, take: 20 },
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((item) => item.severity === 'EMERGENCY' && item.resolved)).toBe(true);
    });

    it('returns all alerts when no filters are given', async () => {
      const { items } = await repository.findMany({}, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
