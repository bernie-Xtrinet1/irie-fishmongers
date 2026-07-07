import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PreferenceResponseEntity } from '../entities/preference-response.entity';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { NotificationPreferencesController } from './notification-preferences.controller';

const user: RequestUser = { id: 'user-1', email: 'jane@example.com', roles: [RoleName.CUSTOMER] };

const preferences: PreferenceResponseEntity = {
  emailEnabled: true,
  pushEnabled: true,
  accountEnabled: true,
  vendorEnabled: true,
  orderUpdatesEnabled: true,
  paymentUpdatesEnabled: true,
  deliveryUpdatesEnabled: true,
};

describe('NotificationPreferencesController', () => {
  let preferencesService: jest.Mocked<Pick<NotificationPreferencesService, 'getMine' | 'updateMine'>>;
  let controller: NotificationPreferencesController;

  beforeEach(() => {
    preferencesService = {
      getMine: jest.fn().mockResolvedValue(preferences),
      updateMine: jest.fn().mockResolvedValue({ ...preferences, emailEnabled: false }),
    };
    controller = new NotificationPreferencesController(
      preferencesService as unknown as NotificationPreferencesService,
    );
  });

  it("gets the authenticated user's notification preferences", async () => {
    const result = await controller.getMine(user);

    expect(result).toEqual(preferences);
    expect(preferencesService.getMine).toHaveBeenCalledWith('user-1');
  });

  it("updates the authenticated user's notification preferences", async () => {
    const result = await controller.updateMine(user, { emailEnabled: false });

    expect(result.emailEnabled).toBe(false);
    expect(preferencesService.updateMine).toHaveBeenCalledWith('user-1', { emailEnabled: false });
  });
});
