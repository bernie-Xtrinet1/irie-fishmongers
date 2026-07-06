import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from './users.repository';

describe('UsersRepository', () => {
  let prisma: PrismaService;
  let repository: UsersRepository;
  let customerRole: Role;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new UsersRepository(prisma);
    const role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    customerRole = role;
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  function uniqueEmail(): string {
    return `test-${randomUUID()}@example.com`;
  }

  it('creates a user with the requested role attached', async () => {
    const email = uniqueEmail();
    const user = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(user.id);

    expect(user.email).toBe(email);
    expect(UsersRepository.toRoleNames(user)).toEqual([RoleName.CUSTOMER]);
    expect(user.status).toBe('PENDING_VERIFICATION');
  });

  it('finds a user by email', async () => {
    const email = uniqueEmail();
    const created = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(created.id);

    const found = await repository.findByEmail(email);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when a user cannot be found by email', async () => {
    await expect(repository.findByEmail(uniqueEmail())).resolves.toBeNull();
  });

  it('marks a user as email-verified and clears the token', async () => {
    const email = uniqueEmail();
    const created = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(created.id);

    await repository.markEmailVerified(created.id);

    const found = await repository.findById(created.id);
    expect(found?.status).toBe('ACTIVE');
    expect(found?.emailVerificationTokenHash).toBeNull();
    expect(found?.emailVerifiedAt).not.toBeNull();
  });

  it('sets and resolves a password reset token', async () => {
    const email = uniqueEmail();
    const created = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(created.id);

    await repository.setPasswordResetToken(created.id, 'reset-hash', new Date(Date.now() + 60_000));

    const found = await repository.findByPasswordResetTokenHash('reset-hash');
    expect(found?.id).toBe(created.id);
  });

  it('resets the password and clears the reset token', async () => {
    const email = uniqueEmail();
    const created = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(created.id);
    await repository.setPasswordResetToken(created.id, 'reset-hash', new Date(Date.now() + 60_000));

    await repository.resetPassword(created.id, 'new-hash');

    const found = await repository.findById(created.id);
    expect(found?.passwordHash).toBe('new-hash');
    expect(found?.passwordResetTokenHash).toBeNull();
  });

  it('finds a user by email verification token hash', async () => {
    const email = uniqueEmail();
    const created = await repository.create({
      email,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'unique-verify-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    createdUserIds.push(created.id);

    const found = await repository.findByEmailVerificationTokenHash('unique-verify-hash');
    expect(found?.id).toBe(created.id);
  });
});
