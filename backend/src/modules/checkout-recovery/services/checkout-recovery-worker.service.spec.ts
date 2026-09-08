import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptStaleFencingService } from '../../checkout-attempt/services/checkout-attempt-stale-fencing.service';
import { CheckoutReservationRecoveryService } from '../../inventory/services/checkout-reservation-recovery.service';
import { CheckoutRecoveryWorkerService } from './checkout-recovery-worker.service';
import { CheckoutRecoveryOwnershipLost } from './checkout-recovery-lock.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

describe('Checkout recovery worker', () => {
  const candidate = {
    id: 'attempt',
    customerId: 'customer',
    cartId: 'cart',
    idempotencyKey: 'private-key',
    selectedPath: 'CART_SCOPED',
    lastHeartbeatAt: new Date(0),
  };
  let attempts: { findStalePage: jest.Mock };
  let repository: { findFencedCleanupPage: jest.Mock };
  let fence: { fence: jest.Mock };
  let recovery: { checkoutRevert: jest.Mock };
  let telemetry: { record: jest.Mock };
  let lease: { assertHeld: jest.Mock };
  let worker: CheckoutRecoveryWorkerService;
  beforeEach(() => {
    attempts = {
      findStalePage: jest
        .fn()
        .mockResolvedValue({ ok: true, page: { items: [candidate], nextCursor: null } }),
    };
    repository = { findFencedCleanupPage: jest.fn().mockResolvedValue([]) };
    fence = { fence: jest.fn().mockResolvedValue({ ok: true, outcome: 'FENCED' }) };
    recovery = {
      checkoutRevert: jest.fn().mockResolvedValue({
        ok: true,
        admissionSuspended: false,
        restoredProductIds: ['product'],
        deletedProductIds: [],
      }),
    };
    telemetry = { record: jest.fn() };
    lease = { assertHeld: jest.fn().mockResolvedValue(undefined) };
    worker = new CheckoutRecoveryWorkerService(
      attempts as unknown as CheckoutAttemptService,
      repository as unknown as CheckoutAttemptRepository,
      fence as unknown as CheckoutAttemptStaleFencingService,
      recovery as unknown as CheckoutReservationRecoveryService,
      telemetry as unknown as CheckoutRecoveryTelemetryService,
    );
  });
  it('cleans only after G.PR0 FENCED, using durable cart/key and observed heartbeat', async () => {
    await worker.runCycle(lease);
    expect(fence.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: candidate.id,
        customerId: candidate.customerId,
        selectedPath: 'CART_SCOPED',
        observedHeartbeatAt: candidate.lastHeartbeatAt,
      }),
    );
    expect(fence.fence.mock.invocationCallOrder[0]!).toBeLessThan(
      recovery.checkoutRevert.mock.invocationCallOrder[0]!,
    );
    expect(recovery.checkoutRevert).toHaveBeenCalledWith('cart', 'private-key', expect.any(Number));
    expect(telemetry.record).toHaveBeenCalledWith(
      'checkout_attempt_recovered',
      'CLEANED',
      'CART_SCOPED',
      expect.any(Number),
    );
  });
  it.each([
    'STALE_OBSERVATION',
    'ALREADY_COMMITTED',
    'ALREADY_FAILED',
    'OWNERSHIP_MISMATCH',
    'PATH_MISMATCH',
    'UNKNOWN_PATH',
  ])('does not clean or refence after %s', async (code) => {
    fence.fence.mockResolvedValue({ ok: false, code });
    await worker.runCycle(lease);
    expect(recovery.checkoutRevert).not.toHaveBeenCalled();
    expect(fence.fence).toHaveBeenCalledTimes(1);
  });
  it.each([null, 'LEGACY'])(
    'skips unsupported ownership %s in both queues',
    async (selectedPath) => {
      attempts.findStalePage.mockResolvedValue({
        ok: true,
        page: { items: [{ ...candidate, selectedPath }], nextCursor: null },
      });
      repository.findFencedCleanupPage.mockResolvedValue([{ ...candidate, selectedPath }]);
      await worker.runCycle(lease);
      expect(fence.fence).not.toHaveBeenCalled();
      expect(recovery.checkoutRevert).not.toHaveBeenCalled();
      expect(telemetry.record).toHaveBeenCalledWith(
        'checkout_recovery_skipped',
        selectedPath === null ? 'UNKNOWN_PATH' : 'UNSUPPORTED_LEGACY',
        selectedPath,
      );
    },
  );
  it('retries durable FAILED obligations without attempting another fence', async () => {
    attempts.findStalePage.mockResolvedValue({ ok: true, page: { items: [], nextCursor: null } });
    repository.findFencedCleanupPage.mockResolvedValue([candidate]);
    recovery.checkoutRevert.mockRejectedValueOnce(new Error('secret Redis error'));
    await worker.runCycle(lease);
    await worker.runCycle(lease);
    expect(fence.fence).not.toHaveBeenCalled();
    expect(recovery.checkoutRevert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toMatch(
      /secret|private-key|customer|cart/,
    );
  });
  it('continues after one cleanup failure; reports corruption as incomplete', async () => {
    repository.findFencedCleanupPage.mockResolvedValue([{ ...candidate, id: 'old' }]);
    recovery.checkoutRevert
      .mockRejectedValueOnce(new Error('failure'))
      .mockResolvedValueOnce({ ok: true, admissionSuspended: true });
    await worker.runCycle(lease);
    expect(recovery.checkoutRevert).toHaveBeenCalledTimes(2);
    expect(telemetry.record).toHaveBeenCalledWith(
      'checkout_recovery_failed',
      'CLEANUP_INCOMPLETE',
      'CART_SCOPED',
    );
  });
  it('aborts on lost scheduler session before another mutation', async () => {
    lease.assertHeld.mockRejectedValue(new CheckoutRecoveryOwnershipLost());
    await expect(worker.runCycle(lease)).rejects.toBeInstanceOf(CheckoutRecoveryOwnershipLost);
    expect(fence.fence).not.toHaveBeenCalled();
    expect(recovery.checkoutRevert).not.toHaveBeenCalled();
  });
  it('uses one bounded page per queue and carries cursor progress across cycles', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...candidate, id: String(index) }));
    const last = rows[99]!;
    repository.findFencedCleanupPage.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    attempts.findStalePage.mockResolvedValue({ ok: true, page: { items: [], nextCursor: null } });
    await worker.runCycle(lease);
    expect(recovery.checkoutRevert).toHaveBeenCalledTimes(100);
    expect(repository.findFencedCleanupPage).toHaveBeenCalledTimes(1);
    await worker.runCycle(lease);
    expect(repository.findFencedCleanupPage).toHaveBeenLastCalledWith({
      limit: 100,
      cursor: { id: last.id, lastHeartbeatAt: last.lastHeartbeatAt },
    });
    expect(attempts.findStalePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });
});
