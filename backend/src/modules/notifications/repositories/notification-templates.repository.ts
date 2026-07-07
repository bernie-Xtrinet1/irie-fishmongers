import { Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationEventType, NotificationTemplate } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class NotificationTemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findOne(
    eventType: NotificationEventType,
    channel: NotificationChannel,
  ): Promise<NotificationTemplate | null> {
    return this.prisma.notificationTemplate.findUnique({
      where: { eventType_channel: { eventType, channel } },
    });
  }

  findChannelsForEvent(eventType: NotificationEventType): Promise<NotificationTemplate[]> {
    return this.prisma.notificationTemplate.findMany({ where: { eventType } });
  }
}
