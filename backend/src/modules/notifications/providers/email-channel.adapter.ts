import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel } from '@prisma/client';

import {
  ChannelSendInput,
  ChannelSendResult,
  NotificationChannelAdapter,
} from '../interfaces/notification-channel-adapter.interface';

// SendGrid v3 Mail Send API (https://api.sendgrid.com/v3/mail/send). Field
// names/endpoint follow SendGrid's standard integration but have not been
// verified against a live SendGrid account - confirm before production use
// (same caveat as the WiPay adapter).
@Injectable()
export class EmailChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.EMAIL;

  private readonly logger = new Logger(EmailChannelAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    // When email is explicitly disabled (no approved provider credentials -
    // e.g. Azure staging/UAT), do NOT touch SendGrid config or the network:
    // short-circuit here so a missing SENDGRID_API_KEY can never throw, and
    // record a clear, non-fatal disabled result. Push/in-app channels are
    // unaffected. Never fabricate a provider key to "enable" this path.
    if (this.configService.get<string>('EMAIL_ENABLED') === 'false') {
      this.logger.warn(
        'Email delivery is disabled (EMAIL_ENABLED=false); no email provider configured - skipping SendGrid send.',
      );
      return {
        success: false,
        errorMessage: 'Email delivery is disabled (no email provider configured)',
      };
    }

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.configService.getOrThrow<string>('SENDGRID_API_KEY')}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.recipientEmail }] }],
        from: { email: this.configService.getOrThrow<string>('SENDGRID_FROM_EMAIL') },
        subject: input.title,
        content: [{ type: 'text/plain', value: input.message }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        errorMessage: `SendGrid responded ${response.status}: ${errorBody}`,
      };
    }

    return { success: true, responseSummary: `SendGrid accepted (${response.status})` };
  }
}
