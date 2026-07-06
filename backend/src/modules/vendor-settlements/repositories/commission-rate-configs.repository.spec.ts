import { PrismaService } from '../../../database/prisma.service';
import { CommissionRateConfigsRepository } from './commission-rate-configs.repository';

describe('CommissionRateConfigsRepository', () => {
  let prisma: PrismaService;
  let repository: CommissionRateConfigsRepository;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CommissionRateConfigsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.platformCommissionConfig.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.onModuleDestroy();
  });

  it('creates a commission rate config', async () => {
    const config = await repository.create(0.1);
    createdIds.push(config.id);
    expect(config.commissionRate.toNumber()).toBe(0.1);
  });

  it('returns the most recently created config as current', async () => {
    const older = await repository.create(0.1);
    createdIds.push(older.id);
    const newer = await repository.create(0.12);
    createdIds.push(newer.id);

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.commissionRate.toNumber()).toBe(0.12);
  });
});
