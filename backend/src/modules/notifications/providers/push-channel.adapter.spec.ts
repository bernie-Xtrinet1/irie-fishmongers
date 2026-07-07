import { ConfigService } from '@nestjs/config';
import { DeviceToken } from '@prisma/client';

import { ChannelSendInput } from '../interfaces/notification-channel-adapter.interface';
import { DeviceTokensRepository } from '../repositories/device-tokens.repository';
import { PushChannelAdapter } from './push-channel.adapter';

function buildConfigService(): { getOrThrow: jest.Mock } {
  return {
    getOrThrow: jest.fn((key: string) => (key === 'FCM_SERVER_KEY' ? 'test-fcm-key' : undefined)),
  };
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

function textResponse(body: string, ok: boolean, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
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
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configService = buildConfigService();
    deviceTokensRepository = { findByUserId: jest.fn() };
    adapter = new PushChannelAdapter(
      configService as unknown as ConfigService,
      deviceTokensRepository as unknown as DeviceTokensRepository,
    );
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('returns a failed result without calling fetch when the user has no registered device tokens', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([]);

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'No registered device tokens for this user',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends to FCM with registration_ids for every registered device token', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([
      buildDeviceToken({ token: 'token-a' }),
      buildDeviceToken({ token: 'token-b', platform: 'IOS' }),
    ]);
    fetchMock.mockResolvedValue(textResponse('', true, 200));

    const result = await adapter.send(input);

    expect(result).toEqual({ success: true, responseSummary: 'FCM accepted (200)' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://fcm.googleapis.com/fcm/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'key=test-fcm-key' }) as Record<
          string,
          string
        >,
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      registration_ids: string[];
      notification: { title: string; body: string };
    };
    expect(body.registration_ids).toEqual(['token-a', 'token-b']);
    expect(body.notification).toEqual({ title: 'Order placed', body: 'Thanks for your order!' });
  });

  it('reports failure without throwing when FCM responds with a non-ok status', async () => {
    deviceTokensRepository.findByUserId.mockResolvedValue([buildDeviceToken()]);
    fetchMock.mockResolvedValue(textResponse('Forbidden', false, 403));

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'FCM responded 403: Forbidden',
    });
  });
});
