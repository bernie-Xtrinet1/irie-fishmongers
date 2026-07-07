import { DeviceTokensRepository } from '../repositories/device-tokens.repository';
import { DeviceTokensService } from './device-tokens.service';

describe('DeviceTokensService', () => {
  let deviceTokensRepository: jest.Mocked<Pick<DeviceTokensRepository, 'upsert' | 'remove'>>;
  let service: DeviceTokensService;

  beforeEach(() => {
    deviceTokensRepository = { upsert: jest.fn(), remove: jest.fn() };
    service = new DeviceTokensService(deviceTokensRepository as unknown as DeviceTokensRepository);
  });

  describe('register', () => {
    it('upserts the device token for the user', async () => {
      await service.register('user-1', 'fcm-token-abc', 'ANDROID');

      expect(deviceTokensRepository.upsert).toHaveBeenCalledWith(
        'user-1',
        'fcm-token-abc',
        'ANDROID',
      );
    });
  });

  describe('remove', () => {
    it('removes the device token for the user', async () => {
      await service.remove('user-1', 'fcm-token-abc');

      expect(deviceTokensRepository.remove).toHaveBeenCalledWith('user-1', 'fcm-token-abc');
    });
  });
});
