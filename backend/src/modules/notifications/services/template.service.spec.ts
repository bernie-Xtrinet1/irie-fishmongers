import { InternalServerErrorException } from '@nestjs/common';
import { NotificationTemplate } from '@prisma/client';

import { NotificationTemplatesRepository } from '../repositories/notification-templates.repository';
import { TemplateService } from './template.service';

function buildTemplate(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: 'template-1',
    eventType: 'ORDER_PLACED',
    channel: 'EMAIL',
    subject: 'Order #{{orderId}} placed',
    body: 'Thanks for your order, {{firstName}}! Total: {{totalAmount}}',
    variables: ['orderId', 'firstName', 'totalAmount'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TemplateService', () => {
  let templatesRepository: jest.Mocked<Pick<NotificationTemplatesRepository, 'findOne'>>;
  let service: TemplateService;

  beforeEach(() => {
    templatesRepository = { findOne: jest.fn() };
    service = new TemplateService(templatesRepository as unknown as NotificationTemplatesRepository);
  });

  it('substitutes variables in both subject and body', async () => {
    templatesRepository.findOne.mockResolvedValue(buildTemplate());

    const result = await service.render('ORDER_PLACED', 'EMAIL', {
      orderId: 'order-123',
      firstName: 'Jane',
      totalAmount: 'JMD 5,000',
    });

    expect(result).toEqual({
      title: 'Order #order-123 placed',
      message: 'Thanks for your order, Jane! Total: JMD 5,000',
    });
  });

  it('falls back to the body for the title when subject is null', async () => {
    templatesRepository.findOne.mockResolvedValue(
      buildTemplate({ subject: null, body: 'Hi {{firstName}}, your order shipped.' }),
    );

    const result = await service.render('ORDER_PLACED', 'IN_APP', { firstName: 'Jane' });

    expect(result).toEqual({
      title: 'Hi Jane, your order shipped.',
      message: 'Hi Jane, your order shipped.',
    });
  });

  it('leaves a placeholder untouched when no matching variable is supplied', async () => {
    templatesRepository.findOne.mockResolvedValue(
      buildTemplate({ subject: 'Order #{{orderId}}', body: 'Hello {{firstName}}' }),
    );

    const result = await service.render('ORDER_PLACED', 'EMAIL', {});

    expect(result).toEqual({ title: 'Order #{{orderId}}', message: 'Hello {{firstName}}' });
  });

  it('throws InternalServerErrorException when no template is configured for the eventType/channel pair', async () => {
    templatesRepository.findOne.mockResolvedValue(null);

    await expect(service.render('ORDER_PLACED', 'PUSH', {})).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
