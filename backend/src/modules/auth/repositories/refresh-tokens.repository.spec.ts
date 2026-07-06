import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RefreshTokensRepository } from './refresh-tokens.repository';
import { UsersRepository } from './users.repository';

describe('RefreshTokensRepository', () => {
  let prisma: PrismaService;
  let repository: RefreshTokensRepository;
  let usersRepository: UsersRepository;
  let customerRole: Role;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new RefreshTokensRepository(prisma);
    usersRepository = new UsersRepository(prisma);
    customerRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });

    const user = await usersRepository.create({
      email: `test-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Jane',
      lastName: 'Doe',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a refresh token record', async () => {
    const token = await repository.create(userId, 'hash-1', new Date(Date.now() + 60_000));
    expect(token.userId).toBe(userId);
    expect(token.revokedAt).toBeNull();
  });

  it('finds a valid (non-revoked, non-expired) token by hash', async () => {
    await repository.create(userId, 'hash-2', new Date(Date.now() + 60_000));
    const found = await repository.findValidByTokenHash('hash-2');
    expect(found?.tokenHash).toBe('hash-2');
  });

  it('does not return an expired token', async () => {
    await repository.create(userId, 'hash-expired', new Date(Date.now() - 60_000));
    const found = await repository.findValidByTokenHash('hash-expired');
    expect(found).toBeNull();
  });

  it('does not return a revoked token', async () => {
    const created = await repository.create(userId, 'hash-revoked', new Date(Date.now() + 60_000));
    await repository.revoke(created.id);
    const found = await repository.findValidByTokenHash('hash-revoked');
    expect(found).toBeNull();
  });

  it('revokes all tokens for a user', async () => {
    await repository.create(userId, 'hash-a', new Date(Date.now() + 60_000));
    await repository.create(userId, 'hash-b', new Date(Date.now() + 60_000));

    await repository.revokeAllForUser(userId);

    await expect(repository.findValidByTokenHash('hash-a')).resolves.toBeNull();
    await expect(repository.findValidByTokenHash('hash-b')).resolves.toBeNull();
  });
});
