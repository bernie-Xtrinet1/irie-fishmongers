import { ChannelSendInput } from '../interfaces/notification-channel-adapter.interface';
import { InAppChannelAdapter } from './in-app-channel.adapter';

describe('InAppChannelAdapter', () => {
  const adapter = new InAppChannelAdapter();

  it('always succeeds immediately with no external call', async () => {
    const input: ChannelSendInput = {
      userId: 'user-1',
      recipientEmail: 'customer@example.com',
      title: 'Order placed',
      message: 'Thanks for your order!',
    };

    await expect(adapter.send(input)).resolves.toEqual({ success: true });
  });

  it('exposes IN_APP as its channel', () => {
    expect(adapter.channel).toBe('IN_APP');
  });
});
