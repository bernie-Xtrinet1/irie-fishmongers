import { PrismaService } from '../../../database/prisma.service';
import { SettlementRateConfigsRepository } from './settlement-rate-configs.repository';

describe('SettlementRateConfigsRepository', () => {
  let prisma: PrismaService;
  let repository: SettlementRateConfigsRepository;
  const createdIds: string[] = [];

  const baseInput = {
    baseFee: 150,
    distanceCompensationEnabled: true,
    distanceRatePerKm: 20,
    heavyLoadThresholdLbs: 50,
    heavyLoadBonus: 200,
    peakBonus: 100,
    volumeBonusTier1Threshold: 20,
    volumeBonusTier1Amount: 1000,
    volumeBonusTier2Threshold: 40,
    volumeBonusTier2Amount: 3000,
    volumeBonusTier3Threshold: 60,
    volumeBonusTier3Amount: 5000,
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new SettlementRateConfigsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.settlementRateConfig.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.onModuleDestroy();
  });

  it('creates a rate config', async () => {
    const config = await repository.create(baseInput);
    createdIds.push(config.id);
    expect(config.baseFee.toNumber()).toBe(150);
    expect(config.volumeBonusTier3Amount.toNumber()).toBe(5000);
  });

  it('returns the most recently created config as current', async () => {
    const older = await repository.create(baseInput);
    createdIds.push(older.id);
    const newer = await repository.create({ ...baseInput, baseFee: 175 });
    createdIds.push(newer.id);

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.baseFee.toNumber()).toBe(175);
  });
});
