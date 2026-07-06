import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { FoodSafetyIncidentsRepository } from './food-safety-incidents.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';

describe('FoodSafetyIncidentsRepository', () => {
  let prisma: PrismaService;
  let repository: FoodSafetyIncidentsRepository;
  let vendorUserId: string;
  let lotId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FoodSafetyIncidentsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const lotsRepository = new SeafoodLotsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const vendorUser = await usersRepository.create({
      email: `incidents-repo-vendor-${randomUUID()}@example.com`,
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
    await prisma.foodSafetyIncident.deleteMany({ where: { lotId } });
    await prisma.seafoodLot.deleteMany({ where: { id: lotId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates an incident in OPEN status', async () => {
    const incident = await repository.create({
      lotId,
      reportedById: vendorUserId,
      severity: 'HIGH',
      description: 'Packaging found torn on arrival with visible ice loss',
    });

    expect(incident.status).toBe('OPEN');
    expect(incident.lotId).toBe(lotId);
    expect(incident.severity).toBe('HIGH');
  });

  it('finds an incident by id and returns null when missing', async () => {
    const created = await repository.create({
      lotId,
      reportedById: vendorUserId,
      severity: 'LOW',
      description: 'Minor cosmetic packaging defect noted',
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);

    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates incident status with corrective action and resolvedAt', async () => {
    const created = await repository.create({
      lotId,
      reportedById: vendorUserId,
      severity: 'MEDIUM',
      description: 'Temperature abuse suspected during transit window',
    });

    const resolvedAt = new Date();
    const updated = await repository.updateStatus(created.id, 'RESOLVED', {
      correctiveAction: 'Vendor retrained on packaging procedure',
      resolvedAt,
    });

    expect(updated.status).toBe('RESOLVED');
    expect(updated.correctiveAction).toBe('Vendor retrained on packaging procedure');
    expect(updated.resolvedAt).not.toBeNull();
  });

  it('updates incident status without extra data', async () => {
    const created = await repository.create({
      lotId,
      reportedById: vendorUserId,
      severity: 'LOW',
      description: 'Minor labeling discrepancy identified on inspection',
    });

    const updated = await repository.updateStatus(created.id, 'INVESTIGATING');
    expect(updated.status).toBe('INVESTIGATING');
  });

  it('paginates incidents for a lot', async () => {
    const { items, total } = await repository.findByLotId(lotId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.lotId === lotId)).toBe(true);
  });

  describe('findMany', () => {
    it('filters by severity and status', async () => {
      const created = await repository.create({
        lotId,
        reportedById: vendorUserId,
        severity: 'CRITICAL',
        description: 'Contamination reported by customer complaint intake',
      });

      const { items, total } = await repository.findMany(
        { severity: 'CRITICAL', status: 'OPEN' },
        { skip: 0, take: 20 },
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.some((item) => item.id === created.id)).toBe(true);
    });

    it('returns all incidents when no filters are given', async () => {
      const { items } = await repository.findMany({}, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
