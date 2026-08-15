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

  // Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). revision is
  // assigned by Postgres's own sequence, independent of createdAt entirely -
  // creating rows out of insertion order relative to any manually-set
  // createdAt still yields ascending revision values in creation order, and
  // findCurrent() must follow revision, not createdAt.
  it('findCurrent is revision-ordered, not createdAt-ordered', async () => {
    const first = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
    createdIds.push(first.id);
    const second = await repository.create({ mode: 'CART_SCOPED', updatedById: adminUserId });
    createdIds.push(second.id);

    expect(second.revision).toBeGreaterThan(first.revision);
    const current = await repository.findCurrent();
    expect(current?.id).toBe(second.id);
  });

  // The exact real-world scenario the migration's revision column exists
  // to fix: two rows sharing an identical createdAt (forced here via raw
  // SQL, since @default(now()) cannot produce a genuine tie on demand)
  // must still resolve deterministically to the later-created row by
  // revision - under the old createdAt-ordering, this exact case had no
  // guaranteed deterministic winner.
  it('resolves a genuine createdAt tie deterministically by revision, never by chance', async () => {
    const tiedTimestamp = new Date('2026-08-10T12:00:00.000Z');
    const older = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
    createdIds.push(older.id);
    const newer = await repository.create({ mode: 'DRAINING', updatedById: adminUserId });
    createdIds.push(newer.id);
    await prisma.$executeRaw`UPDATE "reservation_engine_mode_configs" SET "createdAt" = ${tiedTimestamp} WHERE "id" IN (${older.id}, ${newer.id})`;

    const current = await repository.findCurrent();
    expect(current?.id).toBe(newer.id);
    expect(current?.revision).toBe(newer.revision);
  });
});
