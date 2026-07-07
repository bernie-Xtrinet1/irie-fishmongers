import { NotificationChannel } from '@prisma/client';

export interface ChannelSendInput {
  userId: string;
  recipientEmail: string;
  title: string;
  message: string;
}

export interface ChannelSendResult {
  success: boolean;
  responseSummary?: string;
  errorMessage?: string;
}

/**
 * Per notification-standards.md's Centralized Notification Service principle:
 * no other module may call an email/SMS/push provider directly - only
 * NotificationsService, which delegates to whichever adapter matches the
 * Notification.channel being sent. Adding a channel (e.g. SMS once a Twilio
 * credential exists) means writing one adapter, not touching every module
 * that triggers notifications. Mirrors PaymentProviderAdapter's shape.
 */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}
