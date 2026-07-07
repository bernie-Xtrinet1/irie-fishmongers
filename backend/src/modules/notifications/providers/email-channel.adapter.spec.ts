import { ConfigService } from '@nestjs/config';

import { ChannelSendInput } from '../interfaces/notification-channel-adapter.interface';
import { EmailChannelAdapter } from './email-channel.adapter';

function buildConfigService(): { getOrThrow: jest.Mock } {
  const values: Record<string, string> = {
    SENDGRID_API_KEY: 'test-sendgrid-key',
    SENDGRID_FROM_EMAIL: 'orders@iriefishmongers.com',
  };
  return {
    getOrThrow: jest.fn((key: string) => values[key]),
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

describe('EmailChannelAdapter', () => {
  let configService: { getOrThrow: jest.Mock };
  let adapter: EmailChannelAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configService = buildConfigService();
    adapter = new EmailChannelAdapter(configService as unknown as ConfigService);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('reports success when SendGrid responds ok', async () => {
    fetchMock.mockResolvedValue(textResponse('', true, 202));

    const result = await adapter.send(input);

    expect(result).toEqual({ success: true, responseSummary: 'SendGrid accepted (202)' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-sendgrid-key',
        }) as Record<string, string>,
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as {
      personalizations: Array<{ to: Array<{ email: string }> }>;
      from: { email: string };
      subject: string;
      content: Array<{ type: string; value: string }>;
    };
    expect(body.personalizations[0]?.to[0]?.email).toBe('customer@example.com');
    expect(body.from.email).toBe('orders@iriefishmongers.com');
    expect(body.subject).toBe('Order placed');
    expect(body.content[0]).toEqual({ type: 'text/plain', value: 'Thanks for your order!' });
  });

  it('reports failure without throwing when SendGrid responds with a non-ok status', async () => {
    fetchMock.mockResolvedValue(textResponse('Unauthorized', false, 401));

    const result = await adapter.send(input);

    expect(result).toEqual({
      success: false,
      errorMessage: 'SendGrid responded 401: Unauthorized',
    });
  });
});
