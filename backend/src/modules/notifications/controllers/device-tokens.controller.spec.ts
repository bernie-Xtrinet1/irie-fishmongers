import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { DeviceTokensService } from '../services/device-tokens.service';
import { DeviceTokensController } from './device-tokens.controller';

const user: RequestUser = { id: 'user-1', email: 'jane@example.com', roles: [RoleName.CUSTOMER] };

describe('DeviceTokensController', () => {
  let deviceTokensService: jest.Mocked<Pick<DeviceTokensService, 'register' | 'remove'>>;
  let controller: DeviceTokensController;

  beforeEach(() => {
    deviceTokensService = { register: jest.fn(), remove: jest.fn() };
    controller = new DeviceTokensController(deviceTokensService as unknown as DeviceTokensService);
  });

  it('registers a device token for the authenticated user', async () => {
    await controller.register(user, { token: 'fcm-registration-token-abc123', platform: 'ANDROID' });

    expect(deviceTokensService.register).toHaveBeenCalledWith(
      'user-1',
      'fcm-registration-token-abc123',
      'ANDROID',
    );
  });

  it('removes a device token for the authenticated user', async () => {
    await controller.remove(user, 'fcm-registration-token-abc123');

    expect(deviceTokensService.remove).toHaveBeenCalledWith(
      'user-1',
      'fcm-registration-token-abc123',
    );
  });
});
