import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeviceTokensController } from './controllers/device-tokens.controller';
import { NotificationPreferencesController } from './controllers/notification-preferences.controller';
import { NotificationsController } from './controllers/notifications.controller';
import { EmailChannelAdapter } from './providers/email-channel.adapter';
import { InAppChannelAdapter } from './providers/in-app-channel.adapter';
import { PushChannelAdapter } from './providers/push-channel.adapter';
import { DeviceTokensRepository } from './repositories/device-tokens.repository';
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository';
import { NotificationTemplatesRepository } from './repositories/notification-templates.repository';
import { NotificationsRepository } from './repositories/notifications.repository';
import { DeviceTokensService } from './services/device-tokens.service';
import { NotificationEventsListener } from './services/notification-events.listener';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { NotificationsService } from './services/notifications.service';
import { TemplateService } from './services/template.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController, NotificationPreferencesController, DeviceTokensController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    DeviceTokensService,
    TemplateService,
    NotificationEventsListener,
    EmailChannelAdapter,
    PushChannelAdapter,
    InAppChannelAdapter,
    NotificationsRepository,
    NotificationPreferencesRepository,
    NotificationTemplatesRepository,
    DeviceTokensRepository,
  ],
})
export class NotificationsModule {}
