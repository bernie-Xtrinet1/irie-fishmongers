import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from './reservation-engine-mode.service';

// Real-Postgres coverage for the append-only-table concurrency race (see
// ADR-007 Decision 8): because ReservationEngineModeConfig is append-only
// (no row is ever updated, "current" is always the newest by createdAt),
// two concurrent setMode calls that each read the same stale "current"
// mode before writing could otherwise both succeed, leaving an ambiguous
// current state and letting a transition through that was never actually
// valid against what became current. setMode closes this with a
// transaction-scoped Postgres advisory lock
// (pg_advisory_xact_lock(hashtext(...))) serializing the whole
// read-validate-write sequence - this suite proves that serialization
// against a real database, not a mock. Redis/InventoryReservationsService
// are not exercised by either racing transition below (neither touches
// the DRAINING -> LEGACY rollback gate), so they are passed as inert
// stand-ins rather than a real Redis connection - this file's job is
// proving Postgres-side serialization only.
describe('ReservationEngineModeService (real Postgres integration - append-only concurrency)', () => {
  let prisma: PrismaService;
  let repository: ReservationEngineModeConfigRepository;
  let service: ReservationEngineModeService;
  let adminUserId: string;
  const createdConfigIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new ReservationEngineModeConfigRepository(prisma);
    service = new ReservationEngineModeService(
      prisma,
      repository,
      {} as unknown as RedisService,
      {} as unknown as InventoryReservationsService,
    );

    const usersRepository = new UsersRepository(prisma);
    const customerRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const admin = await usersRepository.create({
      email: `reservation-mode-concurrency-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Admin',
      lastName: 'User',
      roleId: customerRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    adminUserId = admin.id;
  });

  afterAll(async () => {
    await prisma.reservationEngineModeConfig.deleteMany({ where: { id: { in: createdConfigIds } } });
    await prisma.user.delete({ where: { id: adminUserId } });
    await prisma.onModuleDestroy();
  });

  it('serializes two concurrent setMode calls racing from the same current mode, never letting a stale transition through', async () => {
    const established = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
    createdConfigIds.push(established.id);

    const [toLegacy, toCartScoped] = await Promise.all([
      service.setMode({ targetMode: 'LEGACY', updatedById: adminUserId }),
      service.setMode({ targetMode: 'CART_SCOPED', updatedById: adminUserId }),
    ]);
    if (toLegacy.ok) {
      createdConfigIds.push(toLegacy.id);
    }
    if (toCartScoped.ok) {
      createdConfigIds.push(toCartScoped.id);
    }

    const succeeded = [toLegacy, toCartScoped].filter((r) => r.ok);
    const rejected = [toLegacy, toCartScoped].filter((r) => !r.ok);

    // Exactly one racer wins - the other is serialized behind it, re-reads
    // the now-current mode (whatever the winner just wrote), and is
    // correctly rejected because MIRROR->LEGACY and MIRROR->CART_SCOPED
    // are not each other's valid successor.
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedResult = rejected[0]!;
    if (!rejectedResult.ok) {
      expect(rejectedResult.code).toBe('INVALID_TRANSITION');
    }

    const finalConfig = await repository.findCurrent();
    const winner = succeeded[0]!;
    if (winner.ok) {
      expect(finalConfig?.id).toBe(winner.id);
      expect(finalConfig?.mode).toBe(winner.mode);
    }
  });

  it('serializes two concurrent identical-target setMode calls, exactly one succeeding - the second correctly rejected as a same-mode self-loop', async () => {
    const established = await repository.create({ mode: 'LEGACY', updatedById: adminUserId });
    createdConfigIds.push(established.id);

    const [first, second] = await Promise.all([
      service.setMode({ targetMode: 'MIRROR', updatedById: adminUserId }),
      service.setMode({ targetMode: 'MIRROR', updatedById: adminUserId }),
    ]);
    if (first.ok) {
      createdConfigIds.push(first.id);
    }
    if (second.ok) {
      createdConfigIds.push(second.id);
    }

    // Both calls request the identical target (LEGACY -> MIRROR) from the
    // identical starting mode. Without serialization, a naive
    // implementation could let both succeed, leaving two redundant MIRROR
    // rows. With the lock, the second call is serialized behind the
    // first: by the time it reads "current", the first has already
    // committed MIRROR, so the second call's own transition is now
    // MIRROR -> MIRROR - a self-loop, which the state-transition table
    // has no entry for (see ADR-007 Decision 8) - and is correctly
    // rejected as INVALID_TRANSITION, not silently re-applied.
    const succeeded = [first, second].filter((r) => r.ok);
    const rejected = [first, second].filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedResult = rejected[0]!;
    if (!rejectedResult.ok) {
      expect(rejectedResult.code).toBe('INVALID_TRANSITION');
      if (rejectedResult.code === 'INVALID_TRANSITION') {
        expect(rejectedResult.from).toBe('MIRROR');
        expect(rejectedResult.to).toBe('MIRROR');
      }
    }

    const finalConfig = await repository.findCurrent();
    expect(finalConfig?.mode).toBe('MIRROR');
  });
});
