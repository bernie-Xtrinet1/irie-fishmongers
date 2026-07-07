import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { NotificationPreferencesRepository } from './notification-preferences.repository';

describe('NotificationPreferencesRepository', () => {
  let prisma: PrismaService;
  let repository: NotificationPreferencesRepository;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new NotificationPreferencesRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const user = await usersRepository.create({
      email: `notification-prefs-repo-${randomUUID()}@example.com`,
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
    await prisma.notificationPreference.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('returns null when no preference row exists for a user', async () => {
    await expect(repository.findByUserId(randomUUID())).resolves.toBeNull();
  });

  it('creates a preference row on first upsert', async () => {
    const created = await repository.upsert(userId, { emailEnabled: false });
    expect(created.userId).toBe(userId);
    expect(created.emailEnabled).toBe(false);
    expect(created.pushEnabled).toBe(true);
  });

  it('finds a preference by userId', async () => {
    const found = await repository.findByUserId(userId);
    expect(found?.userId).toBe(userId);
    expect(found?.emailEnabled).toBe(false);
  });

  it('updates an existing preference row on subsequent upsert', async () => {
    const updated = await repository.upsert(userId, {
      emailEnabled: true,
      orderUpdatesEnabled: false,
    });
    expect(updated.emailEnabled).toBe(true);
    expect(updated.orderUpdatesEnabled).toBe(false);

    const found = await repository.findByUserId(userId);
    expect(found?.emailEnabled).toBe(true);
    expect(found?.orderUpdatesEnabled).toBe(false);
  });
});
