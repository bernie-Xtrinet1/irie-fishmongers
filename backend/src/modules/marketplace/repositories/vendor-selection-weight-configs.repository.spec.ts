import { PrismaService } from '../../../database/prisma.service';
import { VendorSelectionWeightConfigsRepository } from './vendor-selection-weight-configs.repository';

describe('VendorSelectionWeightConfigsRepository', () => {
  let prisma: PrismaService;
  let repository: VendorSelectionWeightConfigsRepository;
  let adminUserId: string;
  const createdIds: string[] = [];

  const baseInput = {
    inventoryWeight: 0.3,
    freshnessWeight: 0.2,
    complianceWeight: 0.2,
    distanceWeight: 0.15,
    ratingWeight: 0.05,
    deliveryCapacityWeight: 0.1,
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new VendorSelectionWeightConfigsRepository(prisma);

    const admin = await prisma.user.create({
      data: {
        email: `vendor-selection-weight-repo-${Date.now()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Admin',
        lastName: 'User',
      },
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await prisma.vendorSelectionWeightConfig.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a weight config', async () => {
    const config = await repository.create({ ...baseInput, updatedById: adminUserId });
    createdIds.push(config.id);
    expect(config.inventoryWeight.toNumber()).toBe(0.3);
    expect(config.ratingWeight.toNumber()).toBe(0.05);
  });

  it('returns the most recently created config as current', async () => {
    const older = await repository.create({ ...baseInput, updatedById: adminUserId });
    createdIds.push(older.id);
    const newer = await repository.create({
      ...baseInput,
      inventoryWeight: 0.4,
      distanceWeight: 0.05,
      updatedById: adminUserId,
    });
    createdIds.push(newer.id);

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.inventoryWeight.toNumber()).toBe(0.4);
  });
});
