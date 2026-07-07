import { PrismaService } from '../../../database/prisma.service';
import { NotificationTemplatesRepository } from './notification-templates.repository';

describe('NotificationTemplatesRepository', () => {
  let prisma: PrismaService;
  let repository: NotificationTemplatesRepository;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new NotificationTemplatesRepository(prisma);
  });

  afterEach(async () => {
    if (createdIds.length > 0) {
      await prisma.notificationTemplate.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  // REGISTRATION_CONFIRMED/PUSH is deliberately not seeded by prisma/seed.ts
  // (only EMAIL and IN_APP are wired for that event), so creating a row here
  // can't collide with - or get deleted alongside - real seed data the rest
  // of the app depends on. Never delete by a bare eventType/channel filter:
  // those are real enum values shared with production seed rows.
  it('returns null when no template exists for an eventType/channel pair', async () => {
    await expect(
      repository.findOne('REGISTRATION_CONFIRMED', 'PUSH'),
    ).resolves.toBeNull();
  });

  it('finds a single template by eventType and channel', async () => {
    const created = await prisma.notificationTemplate.create({
      data: {
        eventType: 'REGISTRATION_CONFIRMED',
        channel: 'PUSH',
        subject: 'Welcome {{firstName}}',
        body: 'Thanks for joining, {{firstName}}!',
        variables: ['firstName'],
      },
    });
    createdIds.push(created.id);

    const found = await repository.findOne('REGISTRATION_CONFIRMED', 'PUSH');
    expect(found?.eventType).toBe('REGISTRATION_CONFIRMED');
    expect(found?.channel).toBe('PUSH');
    expect(found?.subject).toBe('Welcome {{firstName}}');
  });

  it('finds every seeded template for an eventType across channels', async () => {
    const templates = await repository.findChannelsForEvent('VENDOR_APPROVED');
    const channels = templates.map((template) => template.channel).sort();
    expect(channels).toEqual(['EMAIL', 'IN_APP', 'PUSH']);
  });

  it('returns an empty array when no templates exist for an eventType/channel combination', async () => {
    const templates = await repository.findChannelsForEvent('REGISTRATION_CONFIRMED');
    expect(templates.some((template) => template.channel === 'PUSH')).toBe(false);
  });
});
