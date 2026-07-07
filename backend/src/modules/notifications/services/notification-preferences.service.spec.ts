import { NotificationPreference } from '@prisma/client';

import { NotificationPreferencesRepository } from '../repositories/notification-preferences.repository';
import { NotificationPreferencesService } from './notification-preferences.service';

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

describe('NotificationPreferencesService', () => {
  let preferencesRepository: jest.Mocked<
    Pick<NotificationPreferencesRepository, 'findByUserId' | 'upsert'>
  >;
  let service: NotificationPreferencesService;

  beforeEach(() => {
    preferencesRepository = { findByUserId: jest.fn(), upsert: jest.fn() };
    service = new NotificationPreferencesService(
      preferencesRepository as unknown as NotificationPreferencesRepository,
    );
  });

  describe('getMine', () => {
    it('returns pure defaults when no preference row exists yet', async () => {
      preferencesRepository.findByUserId.mockResolvedValue(null);

      const result = await service.getMine('user-1');

      expect(result).toEqual({
        emailEnabled: true,
        pushEnabled: true,
        accountEnabled: true,
        vendorEnabled: true,
        orderUpdatesEnabled: true,
        paymentUpdatesEnabled: true,
        deliveryUpdatesEnabled: true,
      });
    });

    it('merges defaults with a stored preference when one exists', async () => {
      preferencesRepository.findByUserId.mockResolvedValue(
        buildPreference({ emailEnabled: false, orderUpdatesEnabled: false }),
      );

      const result = await service.getMine('user-1');

      expect(result.emailEnabled).toBe(false);
      expect(result.orderUpdatesEnabled).toBe(false);
      expect(result.pushEnabled).toBe(true);
      expect(result.deliveryUpdatesEnabled).toBe(true);
    });
  });

  describe('updateMine', () => {
    it('upserts the preference and merges it onto the defaults', async () => {
      preferencesRepository.upsert.mockResolvedValue(buildPreference({ pushEnabled: false }));

      const result = await service.updateMine('user-1', { pushEnabled: false });

      expect(preferencesRepository.upsert).toHaveBeenCalledWith('user-1', { pushEnabled: false });
      expect(result.pushEnabled).toBe(false);
      expect(result.emailEnabled).toBe(true);
    });
  });
});
