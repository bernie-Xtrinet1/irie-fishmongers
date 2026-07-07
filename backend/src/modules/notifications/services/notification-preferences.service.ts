import { Injectable } from '@nestjs/common';

import { PreferenceResponseEntity } from '../entities/preference-response.entity';
import {
  NotificationPreferencesRepository,
  UpdatePreferencesInput,
} from '../repositories/notification-preferences.repository';

const DEFAULTS: PreferenceResponseEntity = {
  emailEnabled: true,
  pushEnabled: true,
  accountEnabled: true,
  vendorEnabled: true,
  orderUpdatesEnabled: true,
  paymentUpdatesEnabled: true,
  deliveryUpdatesEnabled: true,
};

@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly preferencesRepository: NotificationPreferencesRepository) {}

  async getMine(userId: string): Promise<PreferenceResponseEntity> {
    const preference = await this.preferencesRepository.findByUserId(userId);
    return preference ? { ...DEFAULTS, ...preference } : DEFAULTS;
  }

  async updateMine(
    userId: string,
    dto: UpdatePreferencesInput,
  ): Promise<PreferenceResponseEntity> {
    const updated = await this.preferencesRepository.upsert(userId, dto);
    return { ...DEFAULTS, ...updated };
  }
}
