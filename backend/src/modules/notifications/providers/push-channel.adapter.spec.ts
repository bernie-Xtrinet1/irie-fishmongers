import { ConfigService } from '@nestjs/config';
import { DeviceToken } from '@prisma/client';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { ChannelSendInput } from '../interfaces/notification-channel-adapter.interface';
import { DeviceTokensRepository } from '../repositories/device-tokens.repository';
import { PushChannelAdapter } from './push-channel.adapter';

// The adapter uses the Firebase Admin SDK (firebase-admin/app +
// firebase-admin/messaging), not the legacy fetch-based FCM HTTP API. Both
// entry points are auto-mocked and configured per test in beforeEach.
jest.mock('firebase-admin/app');
jest.mock('firebase-admin/messaging');

function buildConfigService(): { getOrThrow: jest.Mock } {
  const values: Record<string, string> = {
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'firebase@test-project.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
  };
  return { getOrThrow: jest.fn((key: string) => values[key]) };
}

function buildDeviceToken(overrides: Partial<DeviceToken> = {}): DeviceToken {
  return {
    id: 'device-token-1',
    userId: 'user-1',
    token: 'fcm-token-abc',
    platform: 'ANDROID',
    createdAt: new Date(),
    ...overrides,
  };
}

const input: ChannelSendInput = {
  userId: 'user-1',
  recipientEmail: 'customer@example.com',
  title: 'Order placed',
  message: 'Thanks for your order!',
};

describe('PushChannelAdapter', () => {
  let configService: { getOrThrow: jest.Mock };
  let deviceTokensRepository: jest.Mocked<Pick<DeviceTokensRepository, 'findByUserId'>>;
  let adapter: PushChannelAdapter;
  let sendEachForMulticast: jest.Mock;

  beforeEach(() => {
    configService = buildConfigService();
    deviceTokensRepository = { findByUserId: jest.fn() };
    adapter = new PushChannelAdapter(
      configService as unknown as ConfigService,
      deviceTokensRepository as unknown as DeviceTokensRepository,
    );

    // Report no initialized Firebase app so the credential-init path runs.
    (getApps as jest.Mock).mockReturnValue([]);
    sendEachForMulticast = jest.fn();
    (getMessaging as jest.Mock).mockReturnValue({ sendEachForMulticast });
  });

  it('returns a failed result without calling FCM when the user has no registered device tokens', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([]);

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'No registered device tokens for this user',
    });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('sends a multicast message to every registered device token and reports success', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([
      buildDeviceToken({ token: 'token-a' }),
      buildDeviceToken({ token: 'token-b', platform: 'IOS' }),
    ]);
    sendEachForMulticast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    });

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: true,
      responseSummary: 'FCM accepted 2 message(s); 0 failed',
    });
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const payload = sendEachForMulticast.mock.calls[0][0] as {
      tokens: string[];
      notification: { title: string; body: string };
    };
    expect(payload.tokens).toEqual(['token-a', 'token-b']);
    expect(payload.notification).toEqual({ title: 'Order placed', body: 'Thanks for your order!' });
  });

  it('returns a meaningful error when FCM rejects every message', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([
      buildDeviceToken({ token: 'token-a' }),
      buildDeviceToken({ token: 'token-b' }),
    ]);
    sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        { success: false, error: { message: 'Requested entity was not found' } },
        { success: false, error: { message: 'Invalid registration token' } },
      ],
    });

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'Requested entity was not found',
    });
  });

  it('reports failure without throwing when the FCM provider call throws', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([buildDeviceToken()]);
    sendEachForMulticast.mockRejectedValue(new Error('FCM transport error'));

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'FCM transport error',
    });
  });
});
