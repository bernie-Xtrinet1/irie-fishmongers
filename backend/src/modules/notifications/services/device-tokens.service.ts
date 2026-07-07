import { Injectable } from '@nestjs/common';
import { DevicePlatform } from '@prisma/client';

import { DeviceTokensRepository } from '../repositories/device-tokens.repository';

@Injectable()
export class DeviceTokensService {
  constructor(private readonly deviceTokensRepository: DeviceTokensRepository) {}

  async register(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    await this.deviceTokensRepository.upsert(userId, token, platform);
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.deviceTokensRepository.remove(userId, token);
  }
}
