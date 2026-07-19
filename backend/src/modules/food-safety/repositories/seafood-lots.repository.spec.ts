import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';

describe('SeafoodLotsRepository', () => {
  let prisma: PrismaService;
  let repository: SeafoodLotsRepository;
  let vendorUserId: string;
  let vendorId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new SeafoodLotsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const vendorUser = await usersRepository.create({
      email: `seafood-lots-repo-vendor-${randomUUID()}@example.com`,
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
    vendorId = vendor.id;
  });

  afterAll(async () => {
    await prisma.seafoodLot.deleteMany({ where: { vendorId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a seafood lot in SAFE status', async () => {
    const lot = await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      catchLocation: 'North Coast',
      landingSite: 'Falmouth Landing Site',
      weight: 20,
      weightUnit: 'POUNDS',
    });

    expect(lot.foodSafetyStatus).toBe('SAFE');
    expect(lot.vendorId).toBe(vendorId);
    expect(lot.storageType).toBe('FRESH');
  });

  it('finds a lot by id and by id with vendor', async () => {
    const created = await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 10,
      weightUnit: 'POUNDS',
    });

    const byId = await repository.findById(created.id);
    expect(byId?.id).toBe(created.id);

    const withVendor = await repository.findByIdWithVendor(created.id);
    expect(withVendor?.vendor.businessName).toBe("Vera's Catch");
  });

  it('returns null when a lot does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
    await expect(repository.findByIdWithVendor(randomUUID())).resolves.toBeNull();
  });

  it('updates lot status with notes', async () => {
    const created = await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FROZEN',
      catchDate: new Date(),
      weight: 15,
      weightUnit: 'KILOGRAMS',
    });

    const updated = await repository.updateStatus(created.id, 'UNDER_REVIEW', 'Flagged for review');
    expect(updated.foodSafetyStatus).toBe('UNDER_REVIEW');
    expect(updated.statusNotes).toBe('Flagged for review');
  });

  it('updates grading fields', async () => {
    const created = await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 15,
      weightUnit: 'POUNDS',
    });

    const updated = await repository.updateGrading(created.id, {
      freshnessGrade: 'GRADE_A',
      qualityScore: 95,
    });
    expect(updated.freshnessGrade).toBe('GRADE_A');
    expect(updated.qualityScore).toBe(95);
  });

  it('counts lots created in a given year', async () => {
    const year = new Date().getFullYear();
    const countBefore = await repository.countCreatedThisYear(year);

    await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 15,
      weightUnit: 'POUNDS',
    });

    const countAfter = await repository.countCreatedThisYear(year);
    expect(countAfter).toBe(countBefore + 1);
  });

  it('paginates lots for a vendor', async () => {
    await repository.create({
      lotNumber: `LOT-TEST-${randomUUID()}`,
      vendorId,
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: new Date(),
      weight: 15,
      weightUnit: 'POUNDS',
    });

    const { items, total } = await repository.findManyByVendor(vendorId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.every((item) => item.vendorId === vendorId)).toBe(true);
  });

  describe('findLatestInspectedAt', () => {
    it('returns null when the lot has never been inspected', async () => {
      const created = await repository.create({
        lotNumber: `LOT-TEST-${randomUUID()}`,
        vendorId,
        species: 'Snapper',
        storageType: 'FRESH',
        catchDate: new Date(),
        weight: 15,
        weightUnit: 'POUNDS',
      });

      await expect(repository.findLatestInspectedAt(created.id)).resolves.toBeNull();
    });

    it('returns the most recent inspection timestamp', async () => {
      const created = await repository.create({
        lotNumber: `LOT-TEST-${randomUUID()}`,
        vendorId,
        species: 'Snapper',
        storageType: 'FRESH',
        catchDate: new Date(),
        weight: 15,
        weightUnit: 'POUNDS',
      });

      const inspector = await new UsersRepository(prisma).create({
        email: `seafood-lots-repo-inspector-${randomUUID()}@example.com`,
        passwordHash: 'hashed',
        firstName: 'Ana',
        lastName: 'Inspector',
        roleId: (await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } })).id,
        emailVerificationTokenHash: 'token-hash',
        emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
      });

      const older = new Date('2026-01-01');
      const newer = new Date('2026-02-01');
      await prisma.qualityInspection.create({
        data: {
          lotId: created.id,
          inspectorId: inspector.id,
          result: 'PASSED',
          freshnessGrade: 'GRADE_B',
          qualityScore: 80,
          inspectedAt: older,
        },
      });
      await prisma.qualityInspection.create({
        data: {
          lotId: created.id,
          inspectorId: inspector.id,
          result: 'PASSED',
          freshnessGrade: 'GRADE_A',
          qualityScore: 95,
          inspectedAt: newer,
        },
      });

      const result = await repository.findLatestInspectedAt(created.id);
      expect(result?.getTime()).toBe(newer.getTime());

      await prisma.qualityInspection.deleteMany({ where: { lotId: created.id } });
      await prisma.user.delete({ where: { id: inspector.id } });
    });
  });

  describe('findMany', () => {
    it('filters by vendorId and status', async () => {
      const created = await repository.create({
        lotNumber: `LOT-TEST-${randomUUID()}`,
        vendorId,
        species: 'Snapper',
        storageType: 'FRESH',
        catchDate: new Date(),
        weight: 15,
        weightUnit: 'POUNDS',
      });
      await repository.updateStatus(created.id, 'QUARANTINED', 'Test quarantine');

      const { items, total } = await repository.findMany(
        { vendorId, status: 'QUARANTINED' },
        { skip: 0, take: 20 },
      );
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((item) => item.foodSafetyStatus === 'QUARANTINED')).toBe(true);
    });

    it('returns all lots when no filters are given', async () => {
      const { items } = await repository.findMany({}, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
