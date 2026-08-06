import { CheckoutPendingReconciliationService } from './checkout-pending-reconciliation.service';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  CheckoutPendingLeaseStateResult,
  CheckoutPendingReconciliationInput,
} from './checkout-reservation-state.types';

// CheckoutPendingReconciliationService coverage: dependency-contract-error
// throwing, infrastructure-error propagation, no internal retry, and no
// caller wiring. The full decision-tree/branch-mapping coverage lives in
// checkout-pending-reconciliation.service.spec.ts - split to keep both
// files within the repository's 400-line cap.
describe('CheckoutPendingReconciliationService (dependency contracts)', () => {
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

  describe('dependency contract-error handling', () => {
    it('throws when getCheckoutPendingLeaseState unexpectedly returns INVALID_INPUT', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot be empty',
      });
      await expect(service.reconcileExpiredCheckoutPending(input())).rejects.toThrow(
        'Internal contract error: getCheckoutPendingLeaseState rejected input',
      );
    });

    it('throws when extendCheckoutLease unexpectedly returns INVALID_INPUT', async () => {
      leaseState.getCheckoutPendingLeaseState.mockResolvedValue(
        leaseResult({ expiredLeaseProductIds: ['product-1'] }),
      );
      leaseState.extendCheckoutLease.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'additionalSeconds',
        reason: 'additionalSeconds must be a positive integer',
      });
      await expect(
        service.reconcileExpiredCheckoutPending(input({ durableLastHeartbeatAt: now })),
      ).rejects.toThrow('Internal contract error: extendCheckoutLease rejected input');
    });

    it('throws when checkoutRevert unexpectedly returns INVALID_INPUT', async () => {
      recovery.checkoutRevert.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot be empty',
      });
      await expect(
        service.reconcileExpiredCheckoutPending(input({ durableAttemptState: 'FAILED' })),
      ).rejects.toThrow('Internal contract error: checkoutRevert rejected input');
    });

    it('throws when finalizeCheckoutConsumption unexpectedly returns INVALID_INPUT', async () => {
      recovery.finalizeCheckoutConsumption.mockResolvedValue({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot be empty',
      });
      await expect(
        service.reconcileExpiredCheckoutPending(input({ durableAttemptState: 'COMMITTED' })),
      ).rejects.toThrow('Internal contract error: finalizeCheckoutConsumption rejected input');
    });

    it('propagates an infrastructure error thrown by a dependency unchanged', async () => {
      leaseState.getCheckoutPendingLeaseState.mockRejectedValue(
        new Error('Checkout script result is missing a numeric scriptVersion'),
      );
      await expect(service.reconcileExpiredCheckoutPending(input())).rejects.toThrow(
        'Checkout script result is missing a numeric scriptVersion',
      );
    });
  });

  describe('no internal retry loop', () => {
    it('calls getCheckoutPendingLeaseState exactly once even when it rejects', async () => {
      leaseState.getCheckoutPendingLeaseState.mockRejectedValue(new Error('boom'));
      await expect(service.reconcileExpiredCheckoutPending(input())).rejects.toThrow('boom');
      expect(leaseState.getCheckoutPendingLeaseState).toHaveBeenCalledTimes(1);
    });
  });

  describe('no caller wiring', () => {
    it('is never referenced by CartService, OrdersService, or ProductsService', () => {
      const fs = jest.requireActual<typeof import('fs')>('fs');
      const path = jest.requireActual<typeof import('path')>('path');
      const roots = ['../../cart', '../../orders', '../../products'].map((rel) =>
        path.resolve(__dirname, rel),
      );

      function collectTsFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap((entry: import('fs').Dirent) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return collectTsFiles(full);
          return entry.name.endsWith('.ts') ? [full] : [];
        });
      }

      const offenders: string[] = [];
      for (const root of roots) {
        for (const file of collectTsFiles(root)) {
          const contents = fs.readFileSync(file, 'utf8');
          if (contents.includes('CheckoutPendingReconciliationService')) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
