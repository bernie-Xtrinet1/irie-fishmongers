import { Injectable } from '@nestjs/common';
import { DevicePlatform, DeviceToken } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class DeviceTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsert(userId: string, token: string, platform: DevicePlatform): Promise<DeviceToken> {
    return this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform },
      create: { userId, token, platform },
    });
  }

  findByUserId(userId: string): Promise<DeviceToken[]> {
    return this.prisma.deviceToken.findMany({ where: { userId } });
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }
}
