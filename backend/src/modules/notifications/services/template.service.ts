import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { NotificationChannel, NotificationEventType } from '@prisma/client';

import { NotificationTemplatesRepository } from '../repositories/notification-templates.repository';

export interface RenderedTemplate {
  title: string;
  message: string;
}

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

@Injectable()
export class TemplateService {
  constructor(private readonly templatesRepository: NotificationTemplatesRepository) {}

  async render(
    eventType: NotificationEventType,
    channel: NotificationChannel,
    variables: Record<string, string>,
  ): Promise<RenderedTemplate> {
    const template = await this.templatesRepository.findOne(eventType, channel);
    if (!template) {
      // A missing template for a seeded, wired event/channel pair is a
      // deployment bug (migration/seed drift), not a user-facing error.
      throw new InternalServerErrorException(
        `No notification template configured for ${eventType}/${channel}`,
      );
    }

    return {
      title: TemplateService.substitute(template.subject ?? template.body, variables),
      message: TemplateService.substitute(template.body, variables),
    };
  }

  private static substitute(text: string, variables: Record<string, string>): string {
    return text.replace(VARIABLE_PATTERN, (match, key: string) => variables[key] ?? match);
  }
}
