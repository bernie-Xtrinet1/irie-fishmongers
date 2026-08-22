import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import {
  ChannelSendInput,
  ChannelSendResult,
  NotificationChannelAdapter,
} from '../interfaces/notification-channel-adapter.interface';
import { DeviceTokensRepository } from '../repositories/device-tokens.repository';

@Injectable()
export class PushChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.PUSH;

  constructor(
    private readonly configService: ConfigService,
    private readonly deviceTokensRepository: DeviceTokensRepository,
  ) {}

  private ensureFirebaseInitialized(): void {
    if (getApps().length > 0) {
      return;
    }

    const projectId =
      this.configService.getOrThrow<string>('FIREBASE_PROJECT_ID');

    const clientEmail =
      this.configService.getOrThrow<string>('FIREBASE_CLIENT_EMAIL');

    const privateKey = this.configService
      .getOrThrow<string>('FIREBASE_PRIVATE_KEY')
      .replace(/\\n/g, '\n');

    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    const tokens =
      await this.deviceTokensRepository.findByUserId(input.userId);

    if (tokens.length === 0) {
      return {
        success: false,
        errorMessage: 'No registered device tokens for this user',
      };
    }

    try {
      this.ensureFirebaseInitialized();

      const response = await getMessaging().sendEachForMulticast({
        tokens: tokens.map((deviceToken) => deviceToken.token),
        notification: {
          title: input.title,
          body: input.message,
        },
      });

      if (response.successCount === 0) {
        const firstError = response.responses.find(
          (result) => !result.success,
        )?.error;

        return {
          success: false,
          errorMessage:
            firstError?.message ??
            `FCM rejected all ${response.failureCount} message(s)`,
        };
      }

      return {
        success: true,
        responseSummary:
          `FCM accepted ${response.successCount} message(s); ` +
          `${response.failureCount} failed`,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unknown FCM error',
      };
    }
  }
}
