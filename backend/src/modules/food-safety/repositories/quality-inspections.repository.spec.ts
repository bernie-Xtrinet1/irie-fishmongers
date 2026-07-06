import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { QualityInspectionsRepository } from './quality-inspections.repository';
import { SeafoodLotsRepository } from './seafood-lots.repository';

describe('QualityInspectionsRepository', () => {
  let prisma: PrismaService;
  let repository: QualityInspectionsRepository;
  let adminUserId: string;
  let vendorUserId: string;
  let lotId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new QualityInspectionsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const lotsRepository = new SeafoodLotsRepository(prisma);
    const adminRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    const adminUser = await usersRepository.create({
      email: `quality-inspections-repo-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ana',
      lastName: 'Admin',
      roleId: adminRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = adminUser.id;

    const vendorUser = await usersRepository.create({
      email: `quality-inspections-repo-vendor-${randomUUID()}@example.com`,
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
    await prisma.qualityInspection.deleteMany({ where: { lotId } });
    await prisma.seafoodLot.deleteMany({ where: { id: lotId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a quality inspection', async () => {
    const inspection = await repository.create({
      lotId,
      inspectorId: adminUserId,
      result: 'PASSED',
      freshnessGrade: 'GRADE_A',
      qualityScore: 95,
      notes: 'Looks great',
      photoUrl: 'https://cdn.example.com/inspection.jpg',
    });

    expect(inspection.lotId).toBe(lotId);
    expect(inspection.result).toBe('PASSED');
    expect(inspection.freshnessGrade).toBe('GRADE_A');
  });

  it('paginates inspections for a lot', async () => {
    await repository.create({
      lotId,
      inspectorId: adminUserId,
      result: 'CONDITIONAL',
      freshnessGrade: 'GRADE_B',
      qualityScore: 75,
    });

    const { items, total } = await repository.findByLotId(lotId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.lotId === lotId)).toBe(true);
  });

  it('returns an empty page for a lot with no inspections', async () => {
    const { items, total } = await repository.findByLotId(randomUUID(), { skip: 0, take: 20 });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});
