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

  // Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen atomic-fencing design).
  // Proves the reader-writer relationship between setMode()'s exclusive
  // lock and verifyModeRevisionUnchanged's shared lock actually holds
  // against real Postgres, in both directions - not merely that the two
  // methods compile against the same lock key. Uses the same
  // controlled-delay technique as this codebase's other real-Postgres
  // ordering proofs (see cart-service-concurrency.integration.spec.ts):
  // a spy pauses one side mid-transaction, the test proves the other side
  // is genuinely blocked (not merely slow) via a timed non-resolution
  // check, then releases and proves the correct final ordering.
  describe('exclusive (setMode) vs shared (verifyModeRevisionUnchanged) advisory lock', () => {
    it('verifyModeRevisionUnchanged blocks while a concurrent setMode() transaction holds the exclusive lock, then correctly observes the new mode once it commits', async () => {
      const established = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
      createdConfigIds.push(established.id);
      const observedSnapshot = { revisionId: established.id, revision: established.revision };

      let resolveDelayStarted!: () => void;
      const delayStarted = new Promise<void>((resolve) => {
        resolveDelayStarted = resolve;
      });
      let releaseDelay!: () => void;
      const delayBlocked = new Promise<void>((resolve) => {
        releaseDelay = resolve;
      });
      const realCreate = repository.create.bind(repository);
      const createSpy = jest.spyOn(repository, 'create').mockImplementationOnce(async (...args) => {
        resolveDelayStarted();
        await delayBlocked;
        return realCreate(...args);
      });

      const setModePromise = service.setMode({ targetMode: 'CART_SCOPED', updatedById: adminUserId });
      await delayStarted; // exclusive lock is held; setMode is paused before its own write

      let verifyResolved = false;
      const verifyPromise = prisma
        .$transaction((tx) => service.verifyModeRevisionUnchanged(tx, observedSnapshot))
        .then((result) => {
          verifyResolved = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(verifyResolved).toBe(false); // genuinely blocked, not merely slow

      releaseDelay();
      const setModeResult = await setModePromise;
      const verifyResult = await verifyPromise;
      createSpy.mockRestore();

      expect(verifyResolved).toBe(true);
      expect(setModeResult.ok).toBe(true);
      if (setModeResult.ok) {
        createdConfigIds.push(setModeResult.id);
      }
      // The observed snapshot (the row current before setMode's transition)
      // is provably stale once verify's shared lock finally acquires -
      // setMode() had already committed a new row while it waited.
      expect(verifyResult).toBe(false);
    });

    it('setMode() blocks while a concurrent verifyModeRevisionUnchanged transaction holds the shared lock, and only proceeds once it commits', async () => {
      const established = await repository.create({ mode: 'MIRROR', updatedById: adminUserId });
      createdConfigIds.push(established.id);
      const observedSnapshot = { revisionId: established.id, revision: established.revision };

      let resolveDelayStarted!: () => void;
      const delayStarted = new Promise<void>((resolve) => {
        resolveDelayStarted = resolve;
      });
      let releaseDelay!: () => void;
      const delayBlocked = new Promise<void>((resolve) => {
        releaseDelay = resolve;
      });

      const verifyPromise = prisma.$transaction(async (tx) => {
        const result = await service.verifyModeRevisionUnchanged(tx, observedSnapshot);
        resolveDelayStarted();
        await delayBlocked;
        return result;
      });
      await delayStarted; // shared lock is held; the verify transaction is paused before it commits

      let setModeResolved = false;
      const setModePromise = service
        .setMode({ targetMode: 'LEGACY', updatedById: adminUserId })
        .then((result) => {
          setModeResolved = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(setModeResolved).toBe(false); // genuinely blocked, not merely slow

      releaseDelay();
      const verifyResult = await verifyPromise;
      const setModeResult = await setModePromise;

      expect(verifyResult).toBe(true); // nothing committed while the shared lock was held
      expect(setModeResolved).toBe(true);
      expect(setModeResult.ok).toBe(true);
      if (setModeResult.ok) {
        createdConfigIds.push(setModeResult.id);
      }
    });
  });
});
