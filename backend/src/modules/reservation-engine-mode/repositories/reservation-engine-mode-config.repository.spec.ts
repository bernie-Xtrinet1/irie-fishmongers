import { PrismaService } from '../../../database/prisma.service';
import { ReservationEngineModeConfigRepository } from './reservation-engine-mode-config.repository';

describe('ReservationEngineModeConfigRepository', () => {
  let prisma: PrismaService;
  let repository: ReservationEngineModeConfigRepository;
  let adminUserId: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new ReservationEngineModeConfigRepository(prisma);

    const admin = await prisma.user.create({
      data: {
        email: `reservation-mode-repo-${Date.now()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Admin',
        lastName: 'User',
      },
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await prisma.reservationEngineModeConfig.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('finds no current config before any row exists', async () => {
    await expect(repository.findCurrent()).resolves.toBeNull();
  });

  it('creates a mode config', async () => {
    const config = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
    createdIds.push(config.id);
    expect(config.mode).toBe('MIRROR');
  });

  it('returns the most recently created config as current', async () => {
    const older = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
    createdIds.push(older.id);
    const newer = await repository.create({ mode: 'CART_SCOPED', updatedById: adminUserId });
    createdIds.push(newer.id);

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.mode).toBe('CART_SCOPED');
  });
});
