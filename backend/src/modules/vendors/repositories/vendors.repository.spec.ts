import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { VendorsRepository } from './vendors.repository';

describe('VendorsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorsRepository;
  let usersRepository: UsersRepository;
  let vendorRole: Role;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorsRepository(prisma);
    usersRepository = new UsersRepository(prisma);
    vendorRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const user = await usersRepository.create({
      email: `vendor-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Vera',
      lastName: 'Vendor',
      roleId: vendorRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a vendor profile in PENDING status', async () => {
    const vendor = await repository.create({ userId, businessName: "Vera's Catch" });
    expect(vendor.status).toBe('PENDING');
    expect(vendor.userId).toBe(userId);
  });

  it('finds a vendor by id and by userId', async () => {
    const byUserId = await repository.findByUserId(userId);
    expect(byUserId).not.toBeNull();

    const byId = await repository.findById(byUserId!.id);
    expect(byId?.userId).toBe(userId);
  });

  it('returns null when no vendor profile exists for a user', async () => {
    await expect(repository.findByUserId(randomUUID())).resolves.toBeNull();
  });

  it('updates vendor status', async () => {
    const vendor = await repository.findByUserId(userId);
    const updated = await repository.updateStatus(vendor!.id, 'APPROVED');
    expect(updated.status).toBe('APPROVED');
  });
});
