import { Injectable } from '@nestjs/common';

import {
  CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS,
  MAX_CHECKOUT_PENDING_SECONDS,
  getReservationKeySegmentValidationError,
} from '../constants/inventory.constants';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';
import {
  CheckoutInputValidationFailure,
  CheckoutPendingLeaseStateResult,
  CheckoutPendingReconciliationInput,
  CheckoutPendingReconciliationResult,
  DurableCheckoutAttemptState,
} from './checkout-reservation-state.types';

const VALID_DURABLE_STATES: readonly DurableCheckoutAttemptState[] = [
  'PROCESSING',
  'COMMITTED',
  'FAILED',
  'NOT_FOUND',
];

// Orchestrates checkout-pending recovery from durable CheckoutAttempt state
// (see docs/architecture/reservation-lifecycle.md §10 and the Unit 2.4.4
// decisions). Pure composition over CheckoutLeaseStateService/
// CheckoutReservationRecoveryService - never calls Redis directly, never
// queries Prisma. The durable state/heartbeat are always supplied by the
// caller; no scheduler, no CheckoutAttempt read/write code, no caller
// wiring exists here. Additive and not registered in any module.
@Injectable()
export class CheckoutPendingReconciliationService {
  constructor(
    private readonly leaseState: CheckoutLeaseStateService,
    private readonly recovery: CheckoutReservationRecoveryService,
  ) {}

  async reconcileExpiredCheckoutPending(
    input: CheckoutPendingReconciliationInput,
  ): Promise<CheckoutPendingReconciliationResult> {
    const validationFailure = CheckoutPendingReconciliationService.validateInput(input);
    if (validationFailure) {
      return validationFailure;
    }

    const { cartId, checkoutIdempotencyKey, durableAttemptState, durableLastHeartbeatAt, now } = input;

    switch (durableAttemptState) {
      case 'COMMITTED': {
        const finalizeResult = await this.recovery.finalizeCheckoutConsumption(
          cartId,
          checkoutIdempotencyKey,
        );
        CheckoutPendingReconciliationService.assertOk(finalizeResult, 'finalizeCheckoutConsumption');
        return { ok: true, action: 'FINALIZED', reason: 'DURABLE_ATTEMPT_COMMITTED', finalizeResult };
      }
      case 'FAILED': {
        return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED' };
      }
      case 'NOT_FOUND': {
        return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED' };
      }
      case 'PROCESSING':
        return this.reconcileProcessing(cartId, checkoutIdempotencyKey, durableLastHeartbeatAt, now);
    }
  }

  private async reconcileProcessing(
    cartId: string,
    checkoutIdempotencyKey: string,
    durableLastHeartbeatAt: number | null,
    now: number,
  ): Promise<CheckoutPendingReconciliationResult> {
    const leaseStateResult = await this.leaseState.getCheckoutPendingLeaseState(
      cartId,
      checkoutIdempotencyKey,
      now,
    );
    CheckoutPendingReconciliationService.assertOk(leaseStateResult, 'getCheckoutPendingLeaseState');
    const leaseState: CheckoutPendingLeaseStateResult = leaseStateResult;

    const hardCeilingReached =
      leaseState.hardLimitViolationProductIds.length > 0 ||
      (leaseState.earliestCheckoutPendingAt !== null &&
        now >= leaseState.earliestCheckoutPendingAt + MAX_CHECKOUT_PENDING_SECONDS * 1000);
    if (hardCeilingReached) {
      return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED', leaseState };
    }

    if (leaseState.complete && leaseState.expiredLeaseProductIds.length === 0) {
      return { ok: true, action: 'NONE', reason: 'ACTIVE_REDIS_LEASE', leaseState };
    }

    if (!leaseState.found || !leaseState.complete) {
      return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED', leaseState };
    }

    // Structurally complete, uniformly owned - only the lease itself has
    // expired. This is the one case a fresh durable heartbeat may resync.
    if (durableLastHeartbeatAt === null) {
      return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED', leaseState };
    }

    if (now - durableLastHeartbeatAt > CHECKOUT_HEARTBEAT_FRESHNESS_SECONDS * 1000) {
      return { ok: true, action: 'NONE', reason: 'SETTLEMENT_AUTHORITY_REQUIRED', leaseState };
    }

    // Asserted state and heartbeat do not authenticate operation/attempt authority.
    // G.4b.2c must supply that boundary. No extension or fallback revert here.
    return { ok: true, action: 'NONE', reason: 'EXTENSION_AUTHORITY_REQUIRED', leaseState };
  }
  private static validateInput(
    input: CheckoutPendingReconciliationInput,
  ): CheckoutInputValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(input.cartId, 'cartId');
    if (cartIdError) {
      return { ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: cartIdError };
    }

    if (input.checkoutIdempotencyKey.length === 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot be empty',
      };
    }
    if (/\s/.test(input.checkoutIdempotencyKey)) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot contain whitespace',
      };
    }

    if (!VALID_DURABLE_STATES.includes(input.durableAttemptState)) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'durableAttemptState',
        reason: 'durableAttemptState must be one of PROCESSING, COMMITTED, FAILED, NOT_FOUND',
      };
    }

    if (!Number.isFinite(input.now) || input.now < 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now must be a finite, non-negative number',
      };
    }

    if (input.durableLastHeartbeatAt !== null) {
      if (!Number.isFinite(input.durableLastHeartbeatAt) || input.durableLastHeartbeatAt < 0) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          field: 'durableLastHeartbeatAt',
          reason: 'durableLastHeartbeatAt must be a finite, non-negative number',
        };
      }
      if (input.durableLastHeartbeatAt > input.now) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          field: 'durableLastHeartbeatAt',
          reason: 'durableLastHeartbeatAt cannot be later than now',
        };
      }
    }

    return null;
  }

  // Every dependency call site here already validated its own inputs
  // before calling in, so a dependency's own CheckoutInputValidationFailure
  // is never a normal, expected outcome - it signals a bug in this
  // service's own argument construction. Thrown, never mapped to REVERTED,
  // never retried.
  private static assertOk<T extends { ok: true } | CheckoutInputValidationFailure>(
    result: T,
    dependencyName: string,
  ): asserts result is Extract<T, { ok: true }> {
    if (!result.ok) {
      throw new Error(
        `Internal contract error: ${dependencyName} rejected input that ` +
          `CheckoutPendingReconciliationService already validated (${result.field}: ${result.reason})`,
      );
    }
  }
}
