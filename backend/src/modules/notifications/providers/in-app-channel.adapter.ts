import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';

import {
  ChannelSendInput,
  ChannelSendResult,
  NotificationChannelAdapter,
} from '../interfaces/notification-channel-adapter.interface';

// The Notification row itself IS the in-app notification (surfaced via
// GET /notifications/mine); there is no external provider to call, so
// "sending" is an immediate, always-successful no-op.
@Injectable()
export class InAppChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.IN_APP;

  send(_input: ChannelSendInput): Promise<ChannelSendResult> {
    return Promise.resolve({ success: true });
  }
}
