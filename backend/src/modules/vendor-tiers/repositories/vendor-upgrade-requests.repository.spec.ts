import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorUpgradeRequestsRepository } from './vendor-upgrade-requests.repository';

describe('VendorUpgradeRequestsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorUpgradeRequestsRepository;
  let vendorUserId: string;
  let vendorId: string;
  let adminUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorUpgradeRequestsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const vendorsRepository = new VendorsRepository(prisma);
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });
    const adminRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });

    const vendorUser = await usersRepository.create({
      email: `upgrade-requests-repo-vendor-${randomUUID()}@example.com`,
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
      email: `upgrade-requests-repo-admin-${randomUUID()}@example.com`,
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
    await prisma.vendorUpgradeRequest.deleteMany({ where: { vendorId } });
    await prisma.user.delete({ where: { id: vendorUserId } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates an upgrade request in PENDING status', async () => {
    const request = await repository.create({
      vendorId,
      requestedTier: 'VERIFIED_VENDOR',
      reason: 'Growing customer base, need higher listing limits',
    });

    expect(request.status).toBe('PENDING');
    expect(request.vendorId).toBe(vendorId);
    expect(request.requestedTier).toBe('VERIFIED_VENDOR');
  });

  it('finds an upgrade request by id', async () => {
    const created = await repository.create({ vendorId, requestedTier: 'VERIFIED_VENDOR' });
    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when an upgrade request does not exist', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  describe('findPendingByVendorId', () => {
    it('returns the pending request for a vendor', async () => {
      await prisma.vendorUpgradeRequest.deleteMany({ where: { vendorId } });
      const created = await repository.create({ vendorId, requestedTier: 'VERIFIED_VENDOR' });

      const pending = await repository.findPendingByVendorId(vendorId);
      expect(pending?.id).toBe(created.id);
    });

    it('returns null when the vendor has no pending request', async () => {
      await prisma.vendorUpgradeRequest.deleteMany({ where: { vendorId } });
      const created = await repository.create({ vendorId, requestedTier: 'VERIFIED_VENDOR' });
      await repository.updateStatus(created.id, 'APPROVED', {
        reviewedById: adminUserId,
        reviewedAt: new Date(),
      });

      await expect(repository.findPendingByVendorId(vendorId)).resolves.toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('updates status with review metadata', async () => {
      const created = await repository.create({ vendorId, requestedTier: 'COMMERCIAL_SUPPLIER' });

      const reviewedAt = new Date();
      const updated = await repository.updateStatus(created.id, 'REJECTED', {
        reviewedById: adminUserId,
        reviewedAt,
        reviewNotes: 'Missing required compliance documents',
      });

      expect(updated.status).toBe('REJECTED');
      expect(updated.reviewedById).toBe(adminUserId);
      expect(updated.reviewNotes).toBe('Missing required compliance documents');
    });
  });

  describe('findMany', () => {
    it('filters by status and paginates', async () => {
      await prisma.vendorUpgradeRequest.deleteMany({ where: { vendorId } });
      const created = await repository.create({ vendorId, requestedTier: 'VERIFIED_VENDOR' });

      const { items, total } = await repository.findMany('PENDING', { skip: 0, take: 20 });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.some((item) => item.id === created.id)).toBe(true);
      expect(items.every((item) => item.status === 'PENDING')).toBe(true);
    });

    it('returns all upgrade requests when no status filter is given', async () => {
      const { items } = await repository.findMany(undefined, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
