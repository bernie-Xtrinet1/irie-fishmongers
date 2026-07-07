import { Injectable } from '@nestjs/common';
import {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  NotificationPriority,
  NotificationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateNotificationInput {
  userId: string;
  category: NotificationCategory;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  priority: NotificationPriority;
  title: string;
  message: string;
  data?: Prisma.InputJsonValue;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateNotificationInput): Promise<Notification> {
    return this.prisma.notification.create({ data: input });
  }

  updateStatus(
    id: string,
    status: NotificationStatus,
    data: { sentAt?: Date } = {},
  ): Promise<Notification> {
    return this.prisma.notification.update({ where: { id }, data: { status, ...data } });
  }

  findById(id: string): Promise<Notification | null> {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  async findManyByUser(
    userId: string,
    page: Page,
  ): Promise<{ items: Notification[]; total: number }> {
    const where: Prisma.NotificationWhereInput = { userId };

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { items, total };
  }

  markRead(id: string): Promise<Notification> {
    return this.prisma.notification.update({
      where: { id },
      data: { status: 'READ', readAt: new Date() },
    });
  }

  async createLog(input: {
    notificationId: string;
    attemptNumber: number;
    success: boolean;
    responseSummary?: string;
    errorMessage?: string;
  }): Promise<void> {
    await this.prisma.notificationLog.create({ data: input });
  }
}
