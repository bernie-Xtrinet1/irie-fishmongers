import { Injectable, NotFoundException } from '@nestjs/common';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  NotificationPreference,
  NotificationPriority,
} from '@prisma/client';

import { UsersRepository } from '../../auth/repositories/users.repository';
import { PaginatedNotificationsEntity } from '../entities/paginated-notifications.entity';
import { NotificationResponseEntity } from '../entities/notification-response.entity';
import { ChannelSendInput } from '../interfaces/notification-channel-adapter.interface';
import { EmailChannelAdapter } from '../providers/email-channel.adapter';
import { InAppChannelAdapter } from '../providers/in-app-channel.adapter';
import { PushChannelAdapter } from '../providers/push-channel.adapter';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { NotificationTemplatesRepository } from '../repositories/notification-templates.repository';
import { NotificationPreferencesRepository } from '../repositories/notification-preferences.repository';
import { TemplateService } from './template.service';

export interface NotifyInput {
  userId: string;
  category: NotificationCategory;
  eventType: NotificationEventType;
  priority: NotificationPriority;
  variables: Record<string, string>;
}

const CATEGORY_PREFERENCE_KEY: Record<
  NotificationCategory,
  keyof NotificationPreference | null
> = {
  ACCOUNT: 'accountEnabled',
  VENDOR: 'vendorEnabled',
  ORDER: 'orderUpdatesEnabled',
  PAYMENT: 'paymentUpdatesEnabled',
  DELIVERY: 'deliveryUpdatesEnabled',
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly notificationsRepository: NotificationsRepository,
    private readonly templatesRepository: NotificationTemplatesRepository,
    private readonly preferencesRepository: NotificationPreferencesRepository,
    private readonly usersRepository: UsersRepository,
    private readonly templateService: TemplateService,
    private readonly emailAdapter: EmailChannelAdapter,
    private readonly pushAdapter: PushChannelAdapter,
    private readonly inAppAdapter: InAppChannelAdapter,
  ) {}

  /**
   * The single entry point every module's event listener calls - per
   * notification-standards.md's Centralized Notification Service principle,
   * no module sends email/push directly. Which channels actually fire for
   * this event is data-driven (whichever channels have a seeded
   * NotificationTemplate for this eventType), not hardcoded here; user
   * preferences then filter that list further.
   */
  async notify(input: NotifyInput): Promise<void> {
    const user = await this.usersRepository.findById(input.userId);
    if (!user) {
      return;
    }

    const preference = await this.preferencesRepository.findByUserId(input.userId);
    const templates = await this.templatesRepository.findChannelsForEvent(input.eventType);

    for (const template of templates) {
      if (!NotificationsService.isChannelAllowed(template.channel, input.category, preference)) {
        continue;
      }

      const rendered = await this.templateService.render(
        input.eventType,
        template.channel,
        input.variables,
      );

      const notification = await this.notificationsRepository.create({
        userId: input.userId,
        category: input.category,
        eventType: input.eventType,
        channel: template.channel,
        priority: input.priority,
        title: rendered.title,
        message: rendered.message,
      });

      const sendInput: ChannelSendInput = {
        userId: input.userId,
        recipientEmail: user.email,
        title: rendered.title,
        message: rendered.message,
      };
      const result = await this.getAdapter(template.channel).send(sendInput);

      await this.notificationsRepository.updateStatus(
        notification.id,
        result.success ? 'SENT' : 'FAILED',
        result.success ? { sentAt: new Date() } : {},
      );
      await this.notificationsRepository.createLog({
        notificationId: notification.id,
        attemptNumber: 1,
        success: result.success,
        responseSummary: result.responseSummary,
        errorMessage: result.errorMessage,
      });
    }
  }

  async listMine(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedNotificationsEntity> {
    const { items, total } = await this.notificationsRepository.findManyByUser(userId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => NotificationsService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async markRead(userId: string, id: string): Promise<NotificationResponseEntity> {
    const notification = await this.notificationsRepository.findById(id);
    if (!notification || notification.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }

    const updated = await this.notificationsRepository.markRead(id);
    return NotificationsService.toResponse(updated);
  }

  private getAdapter(channel: NotificationChannel): EmailChannelAdapter | PushChannelAdapter | InAppChannelAdapter {
    if (channel === 'EMAIL') return this.emailAdapter;
    if (channel === 'PUSH') return this.pushAdapter;
    return this.inAppAdapter;
  }

  private static isChannelAllowed(
    channel: NotificationChannel,
    category: NotificationCategory,
    preference: NotificationPreference | null,
  ): boolean {
    if (channel === 'EMAIL' && preference?.emailEnabled === false) {
      return false;
    }
    if (channel === 'PUSH' && preference?.pushEnabled === false) {
      return false;
    }

    const categoryKey = CATEGORY_PREFERENCE_KEY[category];
    if (categoryKey && preference?.[categoryKey] === false) {
      return false;
    }

    return true;
  }

  private static toResponse(notification: {
    id: string;
    category: NotificationCategory;
    eventType: NotificationEventType;
    channel: NotificationChannel;
    priority: NotificationPriority;
    title: string;
    message: string;
    status: string;
    sentAt: Date | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationResponseEntity {
    return {
      id: notification.id,
      category: notification.category,
      eventType: notification.eventType,
      channel: notification.channel,
      priority: notification.priority,
      title: notification.title,
      message: notification.message,
      status: notification.status as NotificationResponseEntity['status'],
      sentAt: notification.sentAt,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    };
  }
}
