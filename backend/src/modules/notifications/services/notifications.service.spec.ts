import { NotFoundException } from '@nestjs/common';
import {
  Notification,
  NotificationPreference,
  NotificationTemplate,
  Role,
  RoleName,
  UserStatus,
} from '@prisma/client';

import { UsersRepository, UserWithRoles } from '../../auth/repositories/users.repository';
import { ChannelSendResult } from '../interfaces/notification-channel-adapter.interface';
import { EmailChannelAdapter } from '../providers/email-channel.adapter';
import { InAppChannelAdapter } from '../providers/in-app-channel.adapter';
import { PushChannelAdapter } from '../providers/push-channel.adapter';
import { NotificationPreferencesRepository } from '../repositories/notification-preferences.repository';
import { NotificationTemplatesRepository } from '../repositories/notification-templates.repository';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { NotificationsService, NotifyInput } from './notifications.service';
import { TemplateService } from './template.service';

function buildUser(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  const role: Role = {
    id: 'role-1',
    name: RoleName.CUSTOMER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    id: 'user-1',
    email: 'jane@example.com',
    passwordHash: 'hashed',
    firstName: 'Jane',
    lastName: 'Doe',
    phone: null,
    status: UserStatus.ACTIVE,
    emailVerifiedAt: new Date(),
    emailVerificationTokenHash: null,
    emailVerificationTokenExpiresAt: null,
    passwordResetTokenHash: null,
    passwordResetTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: [{ id: 'ur-1', userId: 'user-1', roleId: 'role-1', createdAt: new Date(), role }],
    ...overrides,
  };
}

function buildTemplate(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: 'template-1',
    eventType: 'ORDER_PLACED',
    channel: 'EMAIL',
    subject: 'Order placed',
    body: 'Your order has been placed',
    variables: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildPreference(overrides: Partial<NotificationPreference> = {}): NotificationPreference {
  return {
    id: 'pref-1',
    userId: 'user-1',
    emailEnabled: true,
    pushEnabled: true,
    accountEnabled: true,
    vendorEnabled: true,
    orderUpdatesEnabled: true,
    paymentUpdatesEnabled: true,
    deliveryUpdatesEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notification-1',
    userId: 'user-1',
    category: 'ORDER',
    eventType: 'ORDER_PLACED',
    channel: 'EMAIL',
    priority: 'NORMAL',
    title: 'Order placed',
    message: 'Your order has been placed',
    data: null,
    status: 'PENDING',
    sentAt: null,
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const notifyInput: NotifyInput = {
  userId: 'user-1',
  category: 'ORDER',
  eventType: 'ORDER_PLACED',
  priority: 'NORMAL',
  variables: { orderId: 'order-1' },
};

describe('NotificationsService', () => {
  let notificationsRepository: jest.Mocked<
    Pick<NotificationsRepository, 'create' | 'updateStatus' | 'findById' | 'findManyByUser' | 'markRead' | 'createLog'>
  >;
  let templatesRepository: jest.Mocked<Pick<NotificationTemplatesRepository, 'findChannelsForEvent'>>;
  let preferencesRepository: jest.Mocked<Pick<NotificationPreferencesRepository, 'findByUserId'>>;
  let usersRepository: jest.Mocked<Pick<UsersRepository, 'findById'>>;
  let templateService: jest.Mocked<Pick<TemplateService, 'render'>>;
  let emailAdapter: jest.Mocked<Pick<EmailChannelAdapter, 'send'>>;
  let pushAdapter: jest.Mocked<Pick<PushChannelAdapter, 'send'>>;
  let inAppAdapter: jest.Mocked<Pick<InAppChannelAdapter, 'send'>>;
  let service: NotificationsService;

  beforeEach(() => {
    notificationsRepository = {
      create: jest.fn(),
      updateStatus: jest.fn(),
      findById: jest.fn(),
      findManyByUser: jest.fn(),
      markRead: jest.fn(),
      createLog: jest.fn(),
    };
    templatesRepository = { findChannelsForEvent: jest.fn() };
    preferencesRepository = { findByUserId: jest.fn() };
    usersRepository = { findById: jest.fn() };
    templateService = { render: jest.fn() };
    emailAdapter = { send: jest.fn() };
    pushAdapter = { send: jest.fn() };
    inAppAdapter = { send: jest.fn() };

    service = new NotificationsService(
      notificationsRepository as unknown as NotificationsRepository,
      templatesRepository as unknown as NotificationTemplatesRepository,
      preferencesRepository as unknown as NotificationPreferencesRepository,
      usersRepository as unknown as UsersRepository,
      templateService as unknown as TemplateService,
      emailAdapter as unknown as EmailChannelAdapter,
      pushAdapter as unknown as PushChannelAdapter,
      inAppAdapter as unknown as InAppChannelAdapter,
    );
  });

  describe('notify', () => {
    it('returns silently without sending anything when the user does not exist', async () => {
      usersRepository.findById.mockResolvedValue(null);

      await service.notify(notifyInput);

      expect(templatesRepository.findChannelsForEvent).not.toHaveBeenCalled();
      expect(notificationsRepository.create).not.toHaveBeenCalled();
    });

    it('sends through every channel with a seeded template when preferences allow it', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([
        buildTemplate({ channel: 'EMAIL' }),
        buildTemplate({ channel: 'PUSH' }),
        buildTemplate({ channel: 'IN_APP' }),
      ]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockImplementation((input) =>
        Promise.resolve(buildNotification({ channel: input.channel })),
      );
      emailAdapter.send.mockResolvedValue({ success: true, responseSummary: 'ok' });
      pushAdapter.send.mockResolvedValue({ success: true, responseSummary: 'ok' });
      inAppAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(notificationsRepository.create).toHaveBeenCalledTimes(3);
      expect(emailAdapter.send).toHaveBeenCalledTimes(1);
      expect(pushAdapter.send).toHaveBeenCalledTimes(1);
      expect(inAppAdapter.send).toHaveBeenCalledTimes(1);
      expect(notificationsRepository.updateStatus).toHaveBeenCalledTimes(3);
      expect(notificationsRepository.createLog).toHaveBeenCalledTimes(3);
    });

    it('determines channels from NotificationTemplatesRepository.findChannelsForEvent rather than hardcoding them', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'EMAIL' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification({ channel: 'EMAIL' }));
      emailAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(templatesRepository.findChannelsForEvent).toHaveBeenCalledWith('ORDER_PLACED');
      expect(pushAdapter.send).not.toHaveBeenCalled();
      expect(inAppAdapter.send).not.toHaveBeenCalled();
    });

    it('skips a channel disabled at the channel level and creates no Notification row for it', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(buildPreference({ emailEnabled: false }));
      templatesRepository.findChannelsForEvent.mockResolvedValue([
        buildTemplate({ channel: 'EMAIL' }),
        buildTemplate({ channel: 'IN_APP' }),
      ]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification({ channel: 'IN_APP' }));
      inAppAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(emailAdapter.send).not.toHaveBeenCalled();
      expect(notificationsRepository.create).toHaveBeenCalledTimes(1);
      expect(notificationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'IN_APP' }),
      );
    });

    it('skips the PUSH channel when pushEnabled is false', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(buildPreference({ pushEnabled: false }));
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'PUSH' })]);

      await service.notify(notifyInput);

      expect(pushAdapter.send).not.toHaveBeenCalled();
      expect(notificationsRepository.create).not.toHaveBeenCalled();
    });

    it.each([
      ['ACCOUNT', 'accountEnabled'],
      ['VENDOR', 'vendorEnabled'],
      ['ORDER', 'orderUpdatesEnabled'],
      ['PAYMENT', 'paymentUpdatesEnabled'],
      ['DELIVERY', 'deliveryUpdatesEnabled'],
    ] as const)(
      'skips the channel when the %s category preference key (%s) is disabled',
      async (category, key) => {
        usersRepository.findById.mockResolvedValue(buildUser());
        preferencesRepository.findByUserId.mockResolvedValue(buildPreference({ [key]: false }));
        templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'EMAIL' })]);

        await service.notify({ ...notifyInput, category });

        expect(emailAdapter.send).not.toHaveBeenCalled();
        expect(notificationsRepository.create).not.toHaveBeenCalled();
      },
    );

    it('defaults every channel to allowed when no preference row exists', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'EMAIL' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification());
      emailAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(emailAdapter.send).toHaveBeenCalledTimes(1);
      expect(notificationsRepository.create).toHaveBeenCalledTimes(1);
    });

    it('still creates the Notification row and marks it FAILED when the adapter send fails', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'EMAIL' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      const created = buildNotification({ id: 'notification-failed' });
      notificationsRepository.create.mockResolvedValue(created);
      const failedResult: ChannelSendResult = { success: false, errorMessage: 'SendGrid down' };
      emailAdapter.send.mockResolvedValue(failedResult);

      await service.notify(notifyInput);

      expect(notificationsRepository.create).toHaveBeenCalledTimes(1);
      expect(notificationsRepository.updateStatus).toHaveBeenCalledWith('notification-failed', 'FAILED', {});
      expect(notificationsRepository.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: 'notification-failed',
          success: false,
          errorMessage: 'SendGrid down',
        }),
      );
    });

    it('marks the notification SENT with a sentAt timestamp when the adapter send succeeds', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'EMAIL' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification({ id: 'notification-sent' }));
      emailAdapter.send.mockResolvedValue({ success: true, responseSummary: 'SendGrid accepted (202)' });

      await service.notify(notifyInput);

      expect(notificationsRepository.updateStatus).toHaveBeenCalledWith(
        'notification-sent',
        'SENT',
        { sentAt: expect.any(Date) as Date },
      );
      expect(notificationsRepository.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: 'notification-sent',
          success: true,
          responseSummary: 'SendGrid accepted (202)',
        }),
      );
    });

    it('routes the PUSH channel to the push adapter', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'PUSH' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification({ channel: 'PUSH' }));
      pushAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(pushAdapter.send).toHaveBeenCalledTimes(1);
      expect(emailAdapter.send).not.toHaveBeenCalled();
      expect(inAppAdapter.send).not.toHaveBeenCalled();
    });

    it('routes the IN_APP channel to the in-app adapter', async () => {
      usersRepository.findById.mockResolvedValue(buildUser());
      preferencesRepository.findByUserId.mockResolvedValue(null);
      templatesRepository.findChannelsForEvent.mockResolvedValue([buildTemplate({ channel: 'IN_APP' })]);
      templateService.render.mockResolvedValue({ title: 'Order placed', message: 'Body' });
      notificationsRepository.create.mockResolvedValue(buildNotification({ channel: 'IN_APP' }));
      inAppAdapter.send.mockResolvedValue({ success: true });

      await service.notify(notifyInput);

      expect(inAppAdapter.send).toHaveBeenCalledTimes(1);
      expect(emailAdapter.send).not.toHaveBeenCalled();
      expect(pushAdapter.send).not.toHaveBeenCalled();
    });
  });

  describe('listMine', () => {
    it('paginates and maps notifications to response entities', async () => {
      notificationsRepository.findManyByUser.mockResolvedValue({
        items: [buildNotification()],
        total: 1,
      });

      const result = await service.listMine('user-1', { page: 2, pageSize: 10 });

      expect(notificationsRepository.findManyByUser).toHaveBeenCalledWith('user-1', {
        skip: 10,
        take: 10,
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.items[0]?.id).toBe('notification-1');
    });
  });

  describe('markRead', () => {
    it('marks a notification read when it belongs to the user', async () => {
      notificationsRepository.findById.mockResolvedValue(buildNotification());
      notificationsRepository.markRead.mockResolvedValue(
        buildNotification({ status: 'READ', readAt: new Date() }),
      );

      const result = await service.markRead('user-1', 'notification-1');

      expect(result.status).toBe('READ');
      expect(notificationsRepository.markRead).toHaveBeenCalledWith('notification-1');
    });

    it('throws NotFoundException when the notification does not exist', async () => {
      notificationsRepository.findById.mockResolvedValue(null);

      await expect(service.markRead('user-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(notificationsRepository.markRead).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the notification belongs to a different user', async () => {
      notificationsRepository.findById.mockResolvedValue(buildNotification({ userId: 'other-user' }));

      await expect(service.markRead('user-1', 'notification-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(notificationsRepository.markRead).not.toHaveBeenCalled();
    });
  });
});
