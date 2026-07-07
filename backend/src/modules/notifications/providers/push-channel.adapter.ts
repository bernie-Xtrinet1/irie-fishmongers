import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';

import {
  ChannelSendInput,
  ChannelSendResult,
  NotificationChannelAdapter,
} from '../interfaces/notification-channel-adapter.interface';
import { DeviceTokensRepository } from '../repositories/device-tokens.repository';

// Firebase Cloud Messaging legacy HTTP API
// (https://fcm.googleapis.com/fcm/send). No mobile app exists yet in this
// codebase to register real device tokens, so in practice this adapter
// reports a failed (not thrown) send whenever a user has none registered -
// the notification itself is still recorded, just not delivered via push,
// mirroring how a WARNING/CRITICAL temperature alert is still recorded even
// when nobody acts on it immediately.
@Injectable()
export class PushChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.PUSH;

  constructor(
    private readonly configService: ConfigService,
    private readonly deviceTokensRepository: DeviceTokensRepository,
  ) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const tokens = await this.deviceTokensRepository.findByUserId(input.userId);
    if (tokens.length === 0) {
      return { success: false, errorMessage: 'No registered device tokens for this user' };
    }

    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `key=${this.configService.getOrThrow<string>('FCM_SERVER_KEY')}`,
      },
      body: JSON.stringify({
        registration_ids: tokens.map((deviceToken) => deviceToken.token),
        notification: { title: input.title, body: input.message },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, errorMessage: `FCM responded ${response.status}: ${errorBody}` };
    }

    return { success: true, responseSummary: `FCM accepted (${response.status})` };
  }
}
