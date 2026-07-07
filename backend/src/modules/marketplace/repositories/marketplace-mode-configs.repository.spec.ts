import { PrismaService } from '../../../database/prisma.service';
import { MarketplaceModeConfigsRepository } from './marketplace-mode-configs.repository';

describe('MarketplaceModeConfigsRepository', () => {
  let prisma: PrismaService;
  let repository: MarketplaceModeConfigsRepository;
  let adminUserId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new MarketplaceModeConfigsRepository(prisma);

    const admin = await prisma.user.create({
      data: {
        email: `marketplace-mode-repo-${Date.now()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Admin',
        lastName: 'User',
      },
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await prisma.marketplaceModeConfig.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a mode config', async () => {
    const config = await repository.create({
      customerSelectedEnabled: true,
      bestAvailableEnabled: false,
      updatedById: adminUserId,
    });
    createdIds.push(config.id);
    expect(config.customerSelectedEnabled).toBe(true);
    expect(config.bestAvailableEnabled).toBe(false);
  });

  it('returns the most recently created config as current', async () => {
    const older = await repository.create({
      customerSelectedEnabled: true,
      bestAvailableEnabled: false,
      updatedById: adminUserId,
    });
    createdIds.push(older.id);
    const newer = await repository.create({
      customerSelectedEnabled: true,
      bestAvailableEnabled: true,
      updatedById: adminUserId,
    });
    createdIds.push(newer.id);

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.bestAvailableEnabled).toBe(true);
  });
});
