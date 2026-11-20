import { ReservationEngineMode } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';
import {
  RecoveryFixture,
  ensureMode,
  forceLegacyMode,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
  transitionToCartScoped,
  unresolvedReserveMarker,
} from '../../cart-reservation-sync/services/cart-reservation-sync-recovery-test-helpers';
import { productTotalKey } from '../../inventory/constants/inventory.constants';
import { OrdinaryReservationService } from '../../inventory/services/ordinary-reservation.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { ReservationFenceService } from '../../reservation-fence/services/reservation-fence.service';

jest.setTimeout(30_000);

describe('Conflict-C coordinated mode/fence lifecycle, crash recovery, concurrency & escalation (PG + Redis)', () => {
  let fixture: RecoveryFixture;
  let fenceRepo: ReservationFenceRepository;
  let fenceService: ReservationFenceService;
  let ordinaryService: OrdinaryReservationService;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('conflict-c-coord');
    const redisService = new RedisService(fixture.redisClient);
    fenceRepo = new ReservationFenceRepository(fixture.prisma);
    fenceService = new ReservationFenceService(fenceRepo, redisService);
    ordinaryService = new OrdinaryReservationService(fixture.prisma, redisService);
    await forceLegacyMode(fixture);
  });

  afterAll(async () => {
    await forceLegacyMode(fixture);
    await tearDownRecoveryFixture(fixture);
  });

  async function expectSyncedState(expectedMode: ReservationEngineMode, expectedPhase: string, minEpoch = 1) {
    const modeRow = await fixture.modeConfigRepository.findCurrent();
    const fenceRow = await fixture.prisma.reservationFenceTransition.findFirst({ orderBy: { revision: 'desc' } });
    const rawRedis = await fixture.redisClient.get(RESERVATION_FENCE_KEY);
    expect(modeRow?.mode ?? 'LEGACY').toBe(expectedMode);
    expect(fenceRow).not.toBeNull();
    expect(fenceRow!.status).toBe('ACKNOWLEDGED');
    expect(fenceRow!.mode).toBe(expectedMode);
    expect(fenceRow!.modeRevision).toBe(modeRow?.revision ?? null);
    expect(fenceRow!.phase).toBe(expectedPhase);
    expect(fenceRow!.epoch).toBeGreaterThanOrEqual(minEpoch);
    expect(JSON.parse(rawRedis!)).toEqual(transitionTuple(fenceRow!));
    await expect(fixture.modeService.checkModeFenceConsistency()).resolves.toBe(true);
    return { modeRow: modeRow!, fenceRow: fenceRow! };
  }

  it('1. coordinates LEGACY -> MIRROR -> CART_SCOPED -> DRAINING -> CART_SCOPED -> DRAINING -> LEGACY with drain evidence & retirement', async () => {
    await forceLegacyMode(fixture);
    await fixture.prisma.reservationFenceTransition.deleteMany({ where: { actorId: fixture.adminUserId } });
    await fixture.redisClient.flushdb();

    expect((await fixture.modeService.setMode({ targetMode: 'MIRROR', updatedById: fixture.adminUserId })).ok).toBe(true);
    await expectSyncedState('MIRROR', 'OPEN', 1);

    await transitionToCartScoped(fixture);
    await expectSyncedState('CART_SCOPED', 'OPEN', 1);

    expect((await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId })).ok).toBe(true);
    await expectSyncedState('DRAINING', 'DRAINING', 1);

    expect((await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId })).ok).toBe(true);
    await expectSyncedState('CART_SCOPED', 'OPEN', 1);

    expect((await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId })).ok).toBe(true);
    await expectSyncedState('DRAINING', 'DRAINING', 1);

    expect((await fixture.modeService.setMode({ targetMode: 'LEGACY', updatedById: fixture.adminUserId })).ok).toBe(true);
    const retired = await expectSyncedState('LEGACY', 'RETIRED', 1);
    expect(retired.fenceRow.reason).toBe('RETIRE');
    expect(retired.fenceRow.endpointAcknowledgement).toMatch(/^[0-9a-f-]{36}$/i);

    // Re-entering MIRROR before quarantining/resetting the retired Redis endpoint fails closed.
    const blockedReopen = await fixture.modeService.setMode({ targetMode: 'MIRROR', updatedById: fixture.adminUserId });
    expect(blockedReopen).toMatchObject({ ok: false, code: 'FENCE_DISAGREEMENT' });

    // After endpoint quarantine/flush, LEGACY -> MIRROR allocates epoch = 2 cleanly.
    await fixture.redisClient.del(RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY);
    expect((await fixture.modeService.setMode({ targetMode: 'MIRROR', updatedById: fixture.adminUserId })).ok).toBe(true);
    await expectSyncedState('MIRROR', 'OPEN', 2);
  });

  it('2. W1 rejects stale/disagreeing writes before Redis mutation and distinguishes PHASE_DENIED vs DURABLE_REDIS_DISAGREEMENT', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 2);
    const first = await ordinaryService.reserve(cartId, productId, fixture.customerId, 2);
    expect(first.code).toBe('ACCEPTED');
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('2');

    expect((await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId })).ok).toBe(true);
    const denied = await ordinaryService.reserve(cartId, productId, fixture.customerId, 2);
    expect(denied).toEqual({ code: 'FENCE_REJECTED', reason: 'PHASE_DENIED' });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('2');

    expect((await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId })).ok).toBe(true);
    const rawSaved = await fixture.redisClient.get(RESERVATION_FENCE_KEY);
    await fixture.redisClient.del(RESERVATION_FENCE_KEY);
    const missing = await ordinaryService.reserve(cartId, productId, fixture.customerId, 2);
    expect(missing).toEqual({ code: 'FENCE_REJECTED', reason: 'MISSING_CONTROL' });
    await fixture.redisClient.set(RESERVATION_FENCE_KEY, rawSaved!);

    // Durable disagreement (mode revision unchanged, latest fence in PREPARED state) -> DURABLE_REDIS_DISAGREEMENT.
    const curFence = await fixture.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
    await fixture.prisma.reservationFenceTransition.update({
      where: { id: curFence.id },
      data: { status: 'PREPARED', acknowledgedAt: null },
    });
    const disagreed = await ordinaryService.reserve(cartId, productId, fixture.customerId, 2);
    expect(disagreed).toEqual({ code: 'FENCE_REJECTED', reason: 'DURABLE_REDIS_DISAGREEMENT' });
    await fixture.prisma.reservationFenceTransition.update({
      where: { id: curFence.id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
    });
    expect(await fixture.recoveryService.reconcileOne(markerId, new Date())).toEqual({
      outcome: 'RESOLVED_CONVERGED',
      markerId,
    });
  });

  it('3. crash-safe recovery reconciles both pre-CAS and post-CAS PREPARED transitions without split brain', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const originalEval = fixture.redisClient.eval.bind(fixture.redisClient);
    let intercepted = false;
    const evalSpy = jest.spyOn(fixture.redisClient, 'eval').mockImplementation((...args) => {
      if (!intercepted && typeof args[0] === 'string' && args.includes('CAS')) {
        intercepted = true;
        return Promise.resolve(['STALE_REVISION']);
      }
      return originalEval(...args);
    });

    try {
      const interrupted = await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });
      expect(interrupted).toEqual({ ok: false, code: 'FENCE_DISAGREEMENT', reason: 'STALE_REVISION' });
    } finally {
      evalSpy.mockRestore();
    }

    await expect(fixture.modeService.checkModeFenceConsistency()).resolves.toBe(false);
    const preparedRow = await fixture.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
    expect(preparedRow.status).toBe('PREPARED');
    expect(preparedRow.phase).toBe('DRAINING');

    const recovered = await fixture.modeService.reconcilePendingTransition();
    expect(recovered).toEqual({
      ok: true,
      mode: 'DRAINING',
      modeRevision: preparedRow.modeRevision,
      phase: 'DRAINING',
      reconciled: true,
    });
    await expectSyncedState('DRAINING', 'DRAINING');

    // Post-CAS / pre-ACK crash: Redis already holds the target CAS tuple while PG remains PREPARED.
    await fixture.prisma.reservationFenceTransition.update({
      where: { id: preparedRow.id },
      data: { status: 'PREPARED', acknowledgedAt: null },
    });
    await expect(fixture.modeService.checkModeFenceConsistency()).resolves.toBe(false);
    expect(await fixture.modeService.reconcilePendingTransition()).toEqual({
      ok: true,
      mode: 'DRAINING',
      modeRevision: preparedRow.modeRevision,
      phase: 'DRAINING',
      reconciled: true,
    });
    expect(await fixture.modeService.reconcilePendingTransition()).toEqual({
      ok: true,
      mode: 'DRAINING',
      modeRevision: preparedRow.modeRevision,
      phase: 'DRAINING',
      reconciled: false,
    });
    expect((await fenceService.reconcile()).code).toBe('ACCEPTED');
  });

  it('4. serializes concurrent setMode, ReservationFenceRepository.locked, and verifyModeRevisionUnchanged without deadlocks', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const beforeSnapshot = await fixture.modeService.getCurrentModeSnapshot();

    const [m1, m2, fenceLockResult, verified] = await Promise.all([
      fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId }),
      fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId }),
      fenceRepo.locked(async (tx) => {
        const latest = await fenceRepo.latest(tx);
        return latest?.revision ?? null;
      }),
      fixture.prisma.$transaction((tx) => fixture.modeService.verifyModeRevisionUnchanged(tx, beforeSnapshot)),
    ]);

    expect([m1.ok, m2.ok].filter(Boolean)).toHaveLength(1);
    const rejected = [m1, m2].find((r) => !r.ok);
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', from: 'DRAINING', to: 'DRAINING' });
    expect(fenceLockResult).not.toBeNull();
    expect(typeof verified).toBe('boolean');
    await expectSyncedState('DRAINING', 'DRAINING');
  });

  it('5. escalates persistent mode/fence disagreement after bounded retries and recovers cleanly once fence is repaired', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { markerId, productId } = await unresolvedReserveMarker(fixture, 3);
    const savedFence = await fixture.redisClient.get(RESERVATION_FENCE_KEY);

    // Manufacture unresolved mode/fence disagreement while mode revision remains CART_SCOPED.
    await fixture.redisClient.del(RESERVATION_FENCE_KEY);
    expect((await fixture.modeService.checkModeFenceConsistency())).toBe(false);

    const a1 = await fixture.recoveryService.reconcileOne(markerId, new Date());
    const a2 = await fixture.recoveryService.reconcileOne(markerId, new Date());
    const a3 = await fixture.recoveryService.reconcileOne(markerId, new Date());

    expect(a1).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId });
    expect(a2).toEqual({ outcome: 'REQUEUED_RETRYABLE_FAILURE', markerId });
    expect(a3).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });

    const escalatedRow = await fixture.syncStateRepository.findById(markerId);
    expect(escalatedRow?.status).toBe('BLOCKED');
    expect(escalatedRow?.blockReason).toBe('MODE_NOT_ADMITTING');
    expect(escalatedRow?.lastError).toContain('OPERATOR_ESCALATION: unresolved reservation mode/fence disagreement');

    // Recheck remains BLOCKED while disagreement persists.
    const stillBlocked = await fixture.blockedRecheckService.recheckBlocked(markerId, new Date());
    expect(stillBlocked).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });

    // Restore fence consistency -> blocked recheck unblocks -> recovery converges to Redis total 3.
    await fixture.redisClient.set(RESERVATION_FENCE_KEY, savedFence!);
    expect(await fixture.modeService.checkModeFenceConsistency()).toBe(true);
    const unblocked = await fixture.blockedRecheckService.recheckBlocked(markerId, new Date());
    expect(unblocked).toEqual({ outcome: 'UNBLOCKED_PENDING', markerId });

    const converged = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('3');
  });
});
