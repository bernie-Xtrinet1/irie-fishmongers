import { Injectable } from '@nestjs/common';
import { NotificationPreference } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface UpdatePreferencesInput {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
  accountEnabled?: boolean;
  vendorEnabled?: boolean;
  orderUpdatesEnabled?: boolean;
  paymentUpdatesEnabled?: boolean;
  deliveryUpdatesEnabled?: boolean;
}

@Injectable()
export class NotificationPreferencesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUserId(userId: string): Promise<NotificationPreference | null> {
    return this.prisma.notificationPreference.findUnique({ where: { userId } });
  }

  upsert(userId: string, data: UpdatePreferencesInput): Promise<NotificationPreference> {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }
}
