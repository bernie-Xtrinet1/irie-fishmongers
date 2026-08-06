import { CheckoutPendingReconciliationService } from './checkout-pending-reconciliation.service';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  CheckoutPendingLeaseStateResult,
  CheckoutPendingReconciliationInput,
} from './checkout-reservation-state.types';

// CheckoutPendingReconciliationService coverage: input validation, the
// full durable-state/PROCESSING decision tree, extension-failure fallback
// mapping, and dependency call counts. Dependency-contract-error throwing,
// infrastructure-error propagation, no-internal-retry, and no-caller-wiring
// live in checkout-pending-reconciliation-contract.service.spec.ts - split
// to keep both files within the repository's 400-line cap. This service
// never touches Redis directly, so every dependency is mocked - real-Redis
// behavior of the composed calls is covered by the sibling services' own
// suites and by this unit's real-Redis integration specs.
describe('CheckoutPendingReconciliationService', () => {
  let leaseState: jest.Mocked<
    Pick<CheckoutLeaseStateService, 'getCheckoutPendingLeaseState' | 'extendCheckoutLease'>
  >;
  let recovery: jest.Mocked<
    Pick<CheckoutReservationRecoveryService, 'checkoutRevert' | 'finalizeCheckoutConsumption'>
  >;
  let service: CheckoutPendingReconciliationService;

  const cartId = 'cart-1';
  const checkoutIdempotencyKey = 'checkout-key-1';
  const now = 1_000_000;

  beforeEach(() => {
    leaseState = { getCheckoutPendingLeaseState: jest.fn(), extendCheckoutLease: jest.fn() };
    recovery = { checkoutRevert: jest.fn(), finalizeCheckoutConsumption: jest.fn() };
    service = new CheckoutPendingReconciliationService(
      leaseState as unknown as CheckoutLeaseStateService,
      recovery as unknown as CheckoutReservationRecoveryService,
    );
  });

  function input(overrides: Partial<CheckoutPendingReconciliationInput> = {}): CheckoutPendingReconciliationInput {
    return {
      cartId,
      checkoutIdempotencyKey,
      durableAttemptState: 'PROCESSING',
      durableLastHeartbeatAt: null,
      now,
      ...overrides,
    };
  }

  function leaseResult(overrides: Partial<CheckoutPendingLeaseStateResult> = {}): CheckoutPendingLeaseStateResult {
    return {
      ok: true,
      found: true,
      complete: true,
      allOwnedByCheckoutKey: true,
      earliestCheckoutPendingAt: now - 10_000,
      earliestCheckoutPendingExpiresAt: now + 100_000,
      latestCheckoutPendingExpiresAt: now + 100_000,
      pendingProductIds: ['product-1'],
      activeStatusProductIds: [],
      missingProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      conflictingKeyProductIds: [],
      expiredLeaseProductIds: [],
      hardLimitViolationProductIds: [],
      ...overrides,
    };
  }

  const revertResult = { ok: true as const, restoredProductIds: [], deletedProductIds: ['product-1'], skippedProductIds: [], malformedProductIds: [], versionMismatchedProductIds: [], underflow: [], admissionSuspended: false };
  const finalizeResult = { ok: true as const, finalizedProductIds: ['product-1'], skippedProductIds: [], malformedProductIds: [], versionMismatchedProductIds: [], underflow: [], admissionSuspended: false };
  const extendSuccess = { ok: true as const, alreadyExtended: false, newCheckoutPendingExpiresAt: now + 180_000, extendedProductIds: ['product-1'] };

  describe('input validation', () => {
    it.each([
      [input({ cartId: '' }), 'cartId', 'cartId cannot be empty'],
      [input({ cartId: 'cart 1' }), 'cartId', 'cartId cannot contain whitespace'],
      [input({ checkoutIdempotencyKey: '' }), 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot be empty'],
      [input({ checkoutIdempotencyKey: 'key 1' }), 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot contain whitespace'],
      [
        input({ durableAttemptState: 'BOGUS' as never }),
        'durableAttemptState',
        'durableAttemptState must be one of PROCESSING, COMMITTED, FAILED, NOT_FOUND',
      ],
      [input({ now: Number.NaN }), 'now', 'now must be a finite, non-negative number'],
      [input({ now: -1 }), 'now', 'now must be a finite, non-negative number'],
      [
        input({ durableLastHeartbeatAt: Number.NaN }),
        'durableLastHeartbeatAt',
        'durableLastHeartbeatAt must be a finite, non-negative number',
      ],
      [
        input({ durableLastHeartbeatAt: -1 }),
        'durableLastHeartbeatAt',
        'durableLastHeartbeatAt must be a finite, non-negative number',
      ],
      [
        input({ durableLastHeartbeatAt: now + 1 }),
        'durableLastHeartbeatAt',
        'durableLastHeartbeatAt cannot be later than now',
      ],
    ])('rejects invalid input without calling any dependency', async (givenInput, field, reason) => {
      const result = await service.reconcileExpiredCheckoutPending(givenInput);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field, reason });
      expect(leaseState.getCheckoutPendingLeaseState).not.toHaveBeenCalled();
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
      expect(recovery.checkoutRevert).not.toHaveBeenCalled();
      expect(recovery.finalizeCheckoutConsumption).not.toHaveBeenCalled();
    });

    it('accepts a durableLastHeartbeatAt exactly equal to now', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(leaseResult());
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableLastHeartbeatAt: now }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('non-PROCESSING durable states', () => {
    it('COMMITTED calls finalizeCheckoutConsumption once and returns FINALIZED', async () => {
      recovery.finalizeCheckoutConsumption.mockResolvedValue(finalizeResult);
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableAttemptState: 'COMMITTED' }),
      );
      expect(result).toEqual({
        ok: true,
        action: 'FINALIZED',
        reason: 'DURABLE_ATTEMPT_COMMITTED',
        finalizeResult,
      });
      expect(recovery.finalizeCheckoutConsumption).toHaveBeenCalledTimes(1);
      expect(recovery.finalizeCheckoutConsumption).toHaveBeenCalledWith(cartId, checkoutIdempotencyKey);
      expect(leaseState.getCheckoutPendingLeaseState).not.toHaveBeenCalled();
      expect(recovery.checkoutRevert).not.toHaveBeenCalled();
    });

    it('FAILED calls checkoutRevert once and returns REVERTED/DURABLE_ATTEMPT_FAILED', async () => {
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableAttemptState: 'FAILED' }),
      );
      expect(result).toEqual({ ok: true, action: 'REVERTED', reason: 'DURABLE_ATTEMPT_FAILED', revertResult });
      expect(recovery.checkoutRevert).toHaveBeenCalledTimes(1);
      expect(recovery.checkoutRevert).toHaveBeenCalledWith(cartId, checkoutIdempotencyKey, now);
      expect(leaseState.getCheckoutPendingLeaseState).not.toHaveBeenCalled();
    });

    it('NOT_FOUND calls checkoutRevert once and returns REVERTED/DURABLE_ATTEMPT_NOT_FOUND', async () => {
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableAttemptState: 'NOT_FOUND' }),
      );
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'DURABLE_ATTEMPT_NOT_FOUND',
        revertResult,
      });
      expect(leaseState.getCheckoutPendingLeaseState).not.toHaveBeenCalled();
    });
  });

  describe('PROCESSING - hard ceiling', () => {
    it('reverts when hardLimitViolationProductIds alone is non-empty', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(
        leaseResult({ hardLimitViolationProductIds: ['product-1'] }),
      );
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(input());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.action).toBe('REVERTED');
        expect((result as { reason: string }).reason).toBe('HARD_PENDING_LIMIT_REACHED');
      }
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
    });

    it('reverts when earliestCheckoutPendingAt alone reaches the cart-wide ceiling', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(
        leaseResult({ earliestCheckoutPendingAt: now - 600_000 }),
      );
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(input());
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'HARD_PENDING_LIMIT_REACHED',
        leaseState: leaseResult({ earliestCheckoutPendingAt: now - 600_000 }),
        revertResult,
      });
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
    });
  });

  describe('PROCESSING - active lease', () => {
    it('returns NONE/ACTIVE_REDIS_LEASE for a complete, non-expired cart', async () => {
      const lease = leaseResult();
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(lease);
      const result = await service.reconcileExpiredCheckoutPending(input());
      expect(result).toEqual({ ok: true, action: 'NONE', reason: 'ACTIVE_REDIS_LEASE', leaseState: lease });
      expect(recovery.checkoutRevert).not.toHaveBeenCalled();
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
    });
  });

  describe('PROCESSING - unsafe/incomplete state (direct revert, no extension attempt)', () => {
    it.each([
      ['found: false', leaseResult({ found: false, complete: false })],
      ['missingProductIds non-empty', leaseResult({ complete: false, missingProductIds: ['product-2'] })],
      ['malformedProductIds non-empty', leaseResult({ complete: false, malformedProductIds: ['product-2'] })],
      [
        'versionMismatchedProductIds non-empty',
        leaseResult({ complete: false, versionMismatchedProductIds: ['product-2'] }),
      ],
      ['activeStatusProductIds non-empty', leaseResult({ complete: false, activeStatusProductIds: ['product-2'] })],
      [
        'conflictingKeyProductIds non-empty',
        leaseResult({ complete: false, conflictingKeyProductIds: ['product-2'] }),
      ],
    ])('%s reverts directly with REDIS_STATE_INCOMPLETE, never calling extendCheckoutLease', async (_label, lease) => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(lease);
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(input());
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'REDIS_STATE_INCOMPLETE',
        leaseState: lease,
        revertResult,
      });
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
      expect(recovery.checkoutRevert).toHaveBeenCalledTimes(1);
    });
  });

  describe('PROCESSING - complete, expired lease, heartbeat handling', () => {
    const expiredLease = leaseResult({ expiredLeaseProductIds: ['product-1'] });

    it('reverts with DURABLE_HEARTBEAT_MISSING when durableLastHeartbeatAt is null', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(expiredLease);
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(input({ durableLastHeartbeatAt: null }));
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'DURABLE_HEARTBEAT_MISSING',
        leaseState: expiredLease,
        revertResult,
      });
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
    });

    it('reverts with DURABLE_HEARTBEAT_STALE when the heartbeat is older than the freshness window', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(expiredLease);
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const staleHeartbeat = now - 180_001;
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableLastHeartbeatAt: staleHeartbeat }),
      );
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'DURABLE_HEARTBEAT_STALE',
        leaseState: expiredLease,
        revertResult,
      });
      expect(leaseState.extendCheckoutLease).not.toHaveBeenCalled();
    });

    it('calls extendCheckoutLease with exactly 180 seconds when the heartbeat is fresh', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(expiredLease);
      leaseState.extendCheckoutLease.mockResolvedValue(extendSuccess);
      const freshHeartbeat = now - 180_000;
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableLastHeartbeatAt: freshHeartbeat }),
      );
      expect(leaseState.extendCheckoutLease).toHaveBeenCalledTimes(1);
      expect(leaseState.extendCheckoutLease).toHaveBeenCalledWith(
        cartId,
        checkoutIdempotencyKey,
        now,
        180,
      );
      expect(result).toEqual({
        ok: true,
        action: 'RESYNC_LEASE',
        reason: 'FRESH_DURABLE_HEARTBEAT',
        leaseState: expiredLease,
        leaseExtension: extendSuccess,
      });
      expect(recovery.checkoutRevert).not.toHaveBeenCalled();
    });

    it.each([
      'RESERVATION_NOT_PENDING',
      'CHECKOUT_STATE_INCOMPLETE',
      'RESERVATION_MISSING',
      'RESERVATION_MALFORMED',
      'RESERVATION_VERSION_MISMATCH',
      'RESERVATION_CHECKOUT_KEY_MISMATCH',
      'CHECKOUT_PENDING_HARD_LIMIT_REACHED',
    ] as const)('falls back to checkoutRevert with LEASE_EXTENSION_FAILED when extension fails with %s', async (code) => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(expiredLease);
      leaseState.extendCheckoutLease.mockResolvedValue({ ok: false, code, productIds: [] } as never);
      recovery.checkoutRevert.mockResolvedValue(revertResult);
      const result = await service.reconcileExpiredCheckoutPending(
        input({ durableLastHeartbeatAt: now }),
      );
      expect(result).toEqual({
        ok: true,
        action: 'REVERTED',
        reason: 'LEASE_EXTENSION_FAILED',
        leaseState: expiredLease,
        revertResult,
        extensionFailureCode: code,
      });
      expect(recovery.checkoutRevert).toHaveBeenCalledTimes(1);
    });
  });
});
