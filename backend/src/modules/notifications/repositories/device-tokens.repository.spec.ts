import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { DeviceTokensRepository } from './device-tokens.repository';

describe('DeviceTokensRepository', () => {
  let prisma: PrismaService;
  let repository: DeviceTokensRepository;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DeviceTokensRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const user = await usersRepository.create({
      email: `device-tokens-repo-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Cara',
      lastName: 'Customer',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.deviceToken.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a device token on first upsert', async () => {
    const token = `token-${randomUUID()}`;
    const created = await repository.upsert(userId, token, 'IOS');
    expect(created.userId).toBe(userId);
    expect(created.token).toBe(token);
    expect(created.platform).toBe('IOS');
  });

  it('updates the platform/user for an existing token on subsequent upsert', async () => {
    const token = `token-${randomUUID()}`;
    await repository.upsert(userId, token, 'IOS');
    const updated = await repository.upsert(userId, token, 'ANDROID');
    expect(updated.platform).toBe('ANDROID');
  });

  it('finds all device tokens registered for a user', async () => {
    const tokenA = `token-${randomUUID()}`;
    const tokenB = `token-${randomUUID()}`;
    await repository.upsert(userId, tokenA, 'IOS');
    await repository.upsert(userId, tokenB, 'ANDROID');

    const tokens = await repository.findByUserId(userId);
    const values = tokens.map((deviceToken) => deviceToken.token);
    expect(values).toEqual(expect.arrayContaining([tokenA, tokenB]));
  });

  it('returns an empty array for a user with no device tokens', async () => {
    await expect(repository.findByUserId(randomUUID())).resolves.toEqual([]);
  });

  it('removes a device token for a user', async () => {
    const token = `token-${randomUUID()}`;
    await repository.upsert(userId, token, 'IOS');

    await repository.remove(userId, token);

    const tokens = await repository.findByUserId(userId);
    expect(tokens.find((deviceToken) => deviceToken.token === token)).toBeUndefined();
  });

  it('does not throw when removing a token that does not exist', async () => {
    await expect(repository.remove(userId, `missing-${randomUUID()}`)).resolves.toBeUndefined();
  });
});
