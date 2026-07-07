import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { NotificationsRepository } from './notifications.repository';

describe('NotificationsRepository', () => {
  let prisma: PrismaService;
  let repository: NotificationsRepository;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new NotificationsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });

    const user = await usersRepository.create({
      email: `notifications-repo-${randomUUID()}@example.com`,
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
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a notification', async () => {
    const notification = await repository.create({
      userId,
      category: 'ACCOUNT',
      eventType: 'REGISTRATION_CONFIRMED',
      channel: 'EMAIL',
      priority: 'NORMAL',
      title: 'Welcome',
      message: 'Welcome to IrieFishmongers',
    });

    expect(notification.userId).toBe(userId);
    expect(notification.status).toBe('PENDING');
    expect(notification.sentAt).toBeNull();
  });

  it('finds a notification by id and returns null when missing', async () => {
    const created = await repository.create({
      userId,
      category: 'ACCOUNT',
      eventType: 'REGISTRATION_CONFIRMED',
      channel: 'EMAIL',
      priority: 'NORMAL',
      title: 'Welcome',
      message: 'Welcome to IrieFishmongers',
    });

    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);

    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates notification status with additional data', async () => {
    const created = await repository.create({
      userId,
      category: 'ORDER',
      eventType: 'ORDER_PLACED',
      channel: 'PUSH',
      priority: 'NORMAL',
      title: 'Order placed',
      message: 'Your order has been placed',
    });

    const sentAt = new Date();
    const updated = await repository.updateStatus(created.id, 'SENT', { sentAt });
    expect(updated.status).toBe('SENT');
    expect(updated.sentAt?.getTime()).toBe(sentAt.getTime());
  });

  it('updates notification status without additional data', async () => {
    const created = await repository.create({
      userId,
      category: 'ORDER',
      eventType: 'ORDER_PLACED',
      channel: 'PUSH',
      priority: 'NORMAL',
      title: 'Order placed',
      message: 'Your order has been placed',
    });

    const updated = await repository.updateStatus(created.id, 'FAILED');
    expect(updated.status).toBe('FAILED');
    expect(updated.sentAt).toBeNull();
  });

  it('marks a notification as read', async () => {
    const created = await repository.create({
      userId,
      category: 'ORDER',
      eventType: 'ORDER_ACCEPTED',
      channel: 'IN_APP',
      priority: 'NORMAL',
      title: 'Order accepted',
      message: 'Your order was accepted',
    });

    const updated = await repository.markRead(created.id);
    expect(updated.status).toBe('READ');
    expect(updated.readAt).not.toBeNull();
  });

  it('creates a notification log entry', async () => {
    const created = await repository.create({
      userId,
      category: 'PAYMENT',
      eventType: 'PAYMENT_CONFIRMED',
      channel: 'EMAIL',
      priority: 'HIGH',
      title: 'Payment confirmed',
      message: 'Your payment was confirmed',
    });

    await expect(
      repository.createLog({
        notificationId: created.id,
        attemptNumber: 1,
        success: true,
        responseSummary: 'SendGrid accepted (202)',
      }),
    ).resolves.toBeUndefined();
  });

  describe('findManyByUser', () => {
    it('paginates notifications for a user ordered by newest first', async () => {
      await repository.create({
        userId,
        category: 'VENDOR',
        eventType: 'VENDOR_APPROVED',
        channel: 'EMAIL',
        priority: 'HIGH',
        title: 'Vendor approved',
        message: 'Your vendor account was approved',
      });

      const { items, total } = await repository.findManyByUser(userId, { skip: 0, take: 20 });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((item) => item.userId === userId)).toBe(true);
    });

    it('returns an empty page for a user with no notifications', async () => {
      const { items, total } = await repository.findManyByUser(randomUUID(), {
        skip: 0,
        take: 20,
      });
      expect(items).toEqual([]);
      expect(total).toBe(0);
    });
  });
});
