import {
  productTotalKey,
  reservationHashKey,
} from '../../inventory/constants/inventory.constants';
import { installDelayedReserveOrRenewSpy, installDelayedReserveSpy } from './cart-reservation-sync-recovery-delay-spy-test-helpers';
import {
  RecoveryFixture,
  ensureMode,
  forceLegacyMode,
  setUpRecoveryFixture,
  tearDownRecoveryFixture,
  unresolvedReserveMarker,
} from './cart-reservation-sync-recovery-test-helpers';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen atomic-fencing design).
// Real Postgres + real Redis proof of the mode-race fence itself: a
// recovery attempt that chose its write against one mode identity must
// never be treated as resolved once a transition has moved authority
// elsewhere, including the legal-ABA case (mode string reverts, revision
// does not). The advisory-lock mutual-exclusion mechanism itself is
// already proven directly against ReservationEngineModeService in
// reservation-engine-mode-concurrency.service.spec.ts - this file proves
// the end-to-end consequence through the actual recovery worker.
jest.setTimeout(30_000);

describe('CartReservationSyncRecoveryService mode-transition races (real Postgres + Redis)', () => {
  let fixture: RecoveryFixture;

  beforeAll(async () => {
    fixture = await setUpRecoveryFixture('recovery-mode-race');
    await forceLegacyMode(fixture);
  });

  afterAll(async () => {
    await forceLegacyMode(fixture);
    await tearDownRecoveryFixture(fixture);
  });

  it('A. MIRROR -> CART_SCOPED mid-flight: the old worker must not resolve; the next attempt targets CART_SCOPED', async () => {
    await ensureMode(fixture, 'MIRROR');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 5);

    // The old worker's write happens under MIRROR - convergeLegacy calls
    // legacy reserve() - so delaying that exact call pauses reconcileOne
    // right after its write, before its terminal (locked) resolution.
    const handle = installDelayedReserveSpy(fixture.inventoryReservations);
    const oldWorkerPromise = fixture.recoveryService.reconcileOne(markerId, new Date());
    await handle.staleCallStarted;

    const transition = await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId });
    expect(transition.ok).toBe(true);

    handle.releaseStaleCall();
    const oldWorkerOutcome = await oldWorkerPromise;

    expect(oldWorkerOutcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId });
    // The old worker's legacy write DID physically land (ambiguous by
    // design - see ReservationRecoveryConvergenceService's own doc
    // comment) - what matters is that the marker was never falsely
    // resolved against it.
    const rawLegacy = await fixture.redisClient.hget(reservationHashKey(productId), cartId);
    expect(rawLegacy).not.toBeNull();
    const rowAfterRace = await fixture.syncStateRepository.findById(markerId);
    expect(rowAfterRace?.status).toBe('PENDING');
    expect(rowAfterRace?.resolvedAt).toBeNull();

    // The next attempt re-derives desired state fresh and targets whatever
    // is now current - CART_SCOPED.
    const nextOutcome = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(nextOutcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('5');
  });

  it('B. CART_SCOPED -> DRAINING mid-flight: a reserve-shaped write completing under the old authority must not falsely resolve', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { markerId } = await unresolvedReserveMarker(fixture, 3);

    // The old worker's write happens under CART_SCOPED - convergeCartScoped
    // calls reserveOrRenew.
    const handle = installDelayedReserveOrRenewSpy(fixture.inventoryReservations);
    const oldWorkerPromise = fixture.recoveryService.reconcileOne(markerId, new Date());
    await handle.staleCallStarted;

    const transition = await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });
    expect(transition.ok).toBe(true);

    handle.releaseStaleCall();
    const oldWorkerOutcome = await oldWorkerPromise;

    expect(oldWorkerOutcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId });
    const rowAfterRace = await fixture.syncStateRepository.findById(markerId);
    expect(rowAfterRace?.status).toBe('PENDING');
    expect(rowAfterRace?.resolvedAt).toBeNull();

    // Under the now-current DRAINING mode, a reserve-shaped target is
    // BLOCKED, never silently admitted - the mode change correctly
    // redirected the next attempt's classification, not just its target.
    const nextOutcome = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(nextOutcome).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });

    await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId });
  });

  it('C. DRAINING -> CART_SCOPED while BLOCKED: the recheck notices the mode change and unblocks, retargeting CART_SCOPED', async () => {
    await ensureMode(fixture, 'CART_SCOPED');
    const { productId, markerId } = await unresolvedReserveMarker(fixture, 4);
    await fixture.modeService.setMode({ targetMode: 'DRAINING', updatedById: fixture.adminUserId });

    const blocked = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(blocked).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId });

    await fixture.modeService.setMode({ targetMode: 'CART_SCOPED', updatedById: fixture.adminUserId });

    const unblocked = await fixture.blockedRecheckService.recheckBlocked(markerId, new Date());
    expect(unblocked).toEqual({ outcome: 'UNBLOCKED_PENDING', markerId });

    const converged = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(converged).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    expect(await fixture.redisClient.get(productTotalKey(productId))).toBe('4');
  });

  it('D. legal ABA (MIRROR -> LEGACY -> MIRROR): the old worker is still fenced out even though the mode string reverts', async () => {
    await ensureMode(fixture, 'MIRROR');
    const { cartId, productId, markerId } = await unresolvedReserveMarker(fixture, 6);
    const firstMirrorSnapshot = await fixture.modeService.getCurrentModeSnapshot();

    const handle = installDelayedReserveSpy(fixture.inventoryReservations);
    const oldWorkerPromise = fixture.recoveryService.reconcileOne(markerId, new Date());
    await handle.staleCallStarted;

    // Two legal transitions while the old worker is paused: MIRROR ->
    // LEGACY -> MIRROR. The mode STRING is identical to what the old
    // worker observed, but this is a different row with a different
    // revision.
    await fixture.modeService.setMode({ targetMode: 'LEGACY', updatedById: fixture.adminUserId });
    const secondMirror = await fixture.modeService.setMode({ targetMode: 'MIRROR', updatedById: fixture.adminUserId });
    expect(secondMirror.ok).toBe(true);
    const secondMirrorSnapshot = await fixture.modeService.getCurrentModeSnapshot();

    expect(secondMirrorSnapshot.mode).toBe(firstMirrorSnapshot.mode); // both 'MIRROR'
    expect(secondMirrorSnapshot.revisionId).not.toBe(firstMirrorSnapshot.revisionId); // provably a different transition
    expect(secondMirrorSnapshot.revision).not.toBe(firstMirrorSnapshot.revision);

    handle.releaseStaleCall();
    const oldWorkerOutcome = await oldWorkerPromise;

    // Comparing the mode STRING alone could not have detected this -
    // revision is what defeats the ABA.
    expect(oldWorkerOutcome).toEqual({ outcome: 'REQUEUED_MODE_CHANGED', markerId });
    const rowAfterRace = await fixture.syncStateRepository.findById(markerId);
    expect(rowAfterRace?.status).toBe('PENDING');
    expect(rowAfterRace?.resolvedAt).toBeNull();

    const nextOutcome = await fixture.recoveryService.reconcileOne(markerId, new Date());
    expect(nextOutcome).toEqual({ outcome: 'RESOLVED_CONVERGED', markerId });
    const raw = await fixture.redisClient.hget(reservationHashKey(productId), cartId);
    expect((JSON.parse(raw!) as { quantity: number }).quantity).toBe(6);
  });
});
