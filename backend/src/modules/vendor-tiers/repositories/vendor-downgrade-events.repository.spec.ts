import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorDowngradeEventsRepository } from './vendor-downgrade-events.repository';

describe('VendorDowngradeEventsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorDowngradeEventsRepository;
  let vendorUserId: string;
  let vendorId: string;
  let adminUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorDowngradeEventsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });
    const adminRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });

    const vendorUser = await usersRepository.create({
      email: `downgrade-events-repo-vendor-${randomUUID()}@example.com`,
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

    const adminUser = await usersRepository.create({
      email: `downgrade-events-repo-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ada',
      lastName: 'Admin',
      roleId: adminRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = adminUser.id;
  });

  afterAll(async () => {
    await prisma.vendorDowngradeEvent.deleteMany({ where: { vendorId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a downgrade event with a triggering admin', async () => {
    const event = await repository.create({
      vendorId,
      fromTier: 'VERIFIED_VENDOR',
      toTier: 'COMMUNITY_FISHER',
      reason: 'ADMIN_MANUAL',
      triggeredById: adminUserId,
      notes: 'Vendor requested downgrade for lower fees',
    });

    expect(event.vendorId).toBe(vendorId);
    expect(event.fromTier).toBe('VERIFIED_VENDOR');
    expect(event.toTier).toBe('COMMUNITY_FISHER');
    expect(event.triggeredById).toBe(adminUserId);
  });

  it('creates a downgrade event without a triggering admin (system-detected)', async () => {
    const event = await repository.create({
      vendorId,
      fromTier: 'COMMERCIAL_SUPPLIER',
      toTier: 'VERIFIED_VENDOR',
      reason: 'EXPIRED_DOCUMENTS',
    });

    expect(event.triggeredById).toBeNull();
    expect(event.reason).toBe('EXPIRED_DOCUMENTS');
  });

  describe('findByVendorId', () => {
    it('paginates downgrade events for a vendor ordered by createdAt desc', async () => {
      await prisma.vendorDowngradeEvent.deleteMany({ where: { vendorId } });
      const first = await repository.create({
        vendorId,
        fromTier: 'ENTERPRISE_SUPPLIER',
        toTier: 'COMMERCIAL_SUPPLIER',
        reason: 'COMPLIANCE_BREACH',
        triggeredById: adminUserId,
      });
      const second = await repository.create({
        vendorId,
        fromTier: 'COMMERCIAL_SUPPLIER',
        toTier: 'VERIFIED_VENDOR',
        reason: 'FOOD_SAFETY_VIOLATION',
        triggeredById: adminUserId,
      });

      const { items, total } = await repository.findByVendorId(vendorId, { skip: 0, take: 20 });

      expect(total).toBe(2);
      expect(items.every((item) => item.vendorId === vendorId)).toBe(true);
      expect(items[0]?.id).toBe(second.id);
      expect(items[1]?.id).toBe(first.id);
    });

    it('returns an empty page for a vendor with no downgrade events', async () => {
      const { items, total } = await repository.findByVendorId(randomUUID(), { skip: 0, take: 20 });
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });
  });
});
