import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutStaleSettlementService } from './checkout-stale-settlement.service';
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
  let repository: { findPendingStaleSettlementsPage: jest.Mock; authorizeStaleRecoverySettlement: jest.Mock };
  let recovery: { continueStaleRecoverySettlement: jest.Mock };
  let telemetry: { record: jest.Mock };
  let lease: { assertHeld: jest.Mock };
  let worker: CheckoutRecoveryWorkerService;
  beforeEach(() => {
    attempts = {
      findStalePage: jest
        .fn()
        .mockResolvedValue({ ok: true, page: { items: [candidate], nextCursor: null } }),
    };
    repository = { findPendingStaleSettlementsPage: jest.fn().mockResolvedValue([]),
      authorizeStaleRecoverySettlement: jest.fn().mockResolvedValue({ code: 'AUTHORIZED', manifestId: 'manifest' }) };
    recovery = {
      continueStaleRecoverySettlement: jest.fn().mockResolvedValue({ code: 'SETTLED' }),
    };
    telemetry = { record: jest.fn() };
    lease = { assertHeld: jest.fn().mockResolvedValue(undefined) };
    worker = new CheckoutRecoveryWorkerService(
      attempts as unknown as CheckoutAttemptService,
      repository as unknown as CheckoutRecoverySettlementRepository,
      recovery as unknown as CheckoutStaleSettlementService,
      telemetry as unknown as CheckoutRecoveryTelemetryService,
    );
  });
  it('continues only after atomic authorization, using the exact observed heartbeat', async () => {
    await worker.runCycle(lease);
    expect(repository.authorizeStaleRecoverySettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: candidate.id,
        customerId: candidate.customerId,
        observedHeartbeatAt: candidate.lastHeartbeatAt,
      }),
    );
    expect(repository.authorizeStaleRecoverySettlement.mock.invocationCallOrder[0]!).toBeLessThan(
      recovery.continueStaleRecoverySettlement.mock.invocationCallOrder[0]!,
    );
    expect(recovery.continueStaleRecoverySettlement).toHaveBeenCalledWith('manifest');
    expect(telemetry.record).toHaveBeenCalledWith(
      'checkout_pending_recovered',
      'SETTLEMENT_ACKNOWLEDGED',
      'CART_SCOPED',
      expect.any(Number),
    );
  });
  it.each([
    'DEFERRED',
    'FINALIZATION_REQUIRED',
    'UNRESOLVED',
  ])('does not clean or refence after %s', async (code) => {
    repository.authorizeStaleRecoverySettlement.mockResolvedValue({ code });
    await worker.runCycle(lease);
    expect(recovery.continueStaleRecoverySettlement).not.toHaveBeenCalled();
    expect(repository.authorizeStaleRecoverySettlement).toHaveBeenCalledTimes(1);
  });
  it.each([null, 'LEGACY'])(
    'skips unsupported ownership %s in both queues',
    async (selectedPath) => {
      attempts.findStalePage.mockResolvedValue({
        ok: true,
        page: { items: [{ ...candidate, selectedPath }], nextCursor: null },
      });
      repository.findPendingStaleSettlementsPage.mockResolvedValue([]);
      await worker.runCycle(lease);
      expect(repository.authorizeStaleRecoverySettlement).not.toHaveBeenCalled();
      expect(recovery.continueStaleRecoverySettlement).not.toHaveBeenCalled();
      expect(telemetry.record).toHaveBeenCalledWith(
        'checkout_recovery_skipped',
        selectedPath === null ? 'UNKNOWN_PATH' : 'UNSUPPORTED_LEGACY',
        selectedPath,
      );
    },
  );
  it('retries explicit pending manifest references without allocating another replay', async () => {
    attempts.findStalePage.mockResolvedValue({ ok: true, page: { items: [], nextCursor: null } });
    repository.findPendingStaleSettlementsPage.mockResolvedValue([candidate]);
    recovery.continueStaleRecoverySettlement.mockRejectedValueOnce(new Error('secret Redis error'));
    await worker.runCycle(lease);
    await worker.runCycle(lease);
    expect(repository.authorizeStaleRecoverySettlement).not.toHaveBeenCalled();
    expect(recovery.continueStaleRecoverySettlement).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toMatch(
      /secret|private-key|customer|cart/,
    );
  });
  it('continues after one cleanup failure; reports corruption as incomplete', async () => {
    repository.findPendingStaleSettlementsPage.mockResolvedValue([{ ...candidate, id: 'old' }]);
    recovery.continueStaleRecoverySettlement
      .mockRejectedValueOnce(new Error('failure'))
      .mockResolvedValueOnce({ code: 'UNRESOLVED' });
    await worker.runCycle(lease);
    expect(recovery.continueStaleRecoverySettlement).toHaveBeenCalledTimes(2);
    expect(telemetry.record).toHaveBeenCalledWith(
      'checkout_recovery_failed',
      'CLEANUP_INCOMPLETE',
      'CART_SCOPED',
      expect.any(Number),
    );
  });
  it('aborts on lost scheduler session before another mutation', async () => {
    lease.assertHeld.mockRejectedValue(new CheckoutRecoveryOwnershipLost());
    await expect(worker.runCycle(lease)).rejects.toBeInstanceOf(CheckoutRecoveryOwnershipLost);
    expect(repository.authorizeStaleRecoverySettlement).not.toHaveBeenCalled();
    expect(recovery.continueStaleRecoverySettlement).not.toHaveBeenCalled();
  });
  it('uses one bounded page per queue and carries cursor progress across cycles', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...candidate, id: String(index) }));
    const last = rows[99]!;
    repository.findPendingStaleSettlementsPage.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    attempts.findStalePage.mockResolvedValue({ ok: true, page: { items: [], nextCursor: null } });
    await worker.runCycle(lease);
    expect(recovery.continueStaleRecoverySettlement).toHaveBeenCalledTimes(100);
    expect(repository.findPendingStaleSettlementsPage).toHaveBeenCalledTimes(1);
    await worker.runCycle(lease);
    expect(repository.findPendingStaleSettlementsPage).toHaveBeenLastCalledWith({
      limit: 100,
      afterManifestId: last.id,
    });
    expect(attempts.findStalePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });
});
