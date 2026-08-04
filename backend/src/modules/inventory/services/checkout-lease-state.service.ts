import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import {
  MAX_CHECKOUT_PENDING_SECONDS,
  cartIndexKey,
  getReservationKeySegmentValidationError,
} from '../constants/inventory.constants';
import { CHECKOUT_EXTEND_LEASE_SCRIPT } from '../lua/checkout-lease-extend-lua-scripts';
import { CHECKOUT_LEASE_STATE_SCRIPT } from '../lua/checkout-lease-state-lua-scripts';
import {
  CheckoutExtendLeaseErrorCode,
  CheckoutExtendLeaseResult,
  CheckoutInputValidationFailure,
  CheckoutLeaseStateResult,
} from './checkout-reservation-state.types';

// Script-identity protocol versions, one per script, deliberately not
// shared with CheckoutReservationStateService's own constant - see the
// Unit 2.4.2 decision to keep this service's protocol helpers local
// rather than extract a shared production utility.
const CHECKOUT_LEASE_STATE_SCRIPT_VERSION = 1;
const CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION = 1;

interface RawCheckoutLeaseStateScriptResult {
  scriptVersion?: unknown;
  found?: unknown;
  complete?: unknown;
  allOwnedByCheckoutKey?: unknown;
  earliestCheckoutPendingAt?: unknown;
  earliestCheckoutPendingExpiresAt?: unknown;
  latestCheckoutPendingExpiresAt?: unknown;
  pendingProductIds?: unknown;
  activeStatusProductIds?: unknown;
  missingProductIds?: unknown;
  malformedProductIds?: unknown;
  versionMismatchedProductIds?: unknown;
  conflictingKeyProductIds?: unknown;
  expiredLeaseProductIds?: unknown;
  hardLimitViolationProductIds?: unknown;
}

interface RawCheckoutExtendLeaseScriptResult {
  scriptVersion?: unknown;
  ok?: true;
  err?: string;
  productIds?: unknown;
  pendingProductIds?: unknown;
  activeProductIds?: unknown;
  alreadyExtended?: unknown;
  newCheckoutPendingExpiresAt?: unknown;
  extendedProductIds?: unknown;
}

// Owns whole-cart checkout-pending lease inspection and extension (see
// docs/architecture/reservation-lifecycle.md, Unit 2.4.2). Deliberately a
// sibling of CheckoutReservationStateService, not a method addition to it
// - the Unit 2.4.2 decisions require this split to stay within the
// repository's per-file/per-service size limits. Additive and not wired to
// any caller.
@Injectable()
export class CheckoutLeaseStateService {
  constructor(private readonly redis: RedisService) {}

  async getCheckoutPendingLeaseState(
    cartId: string,
    checkoutIdempotencyKey: string,
    now: number,
  ): Promise<CheckoutLeaseStateResult> {
    const validationFailure = CheckoutLeaseStateService.validateCartCheckoutKeyAndNow(
      cartId,
      checkoutIdempotencyKey,
      now,
    );
    if (validationFailure) {
      return validationFailure;
    }

    const raw = await this.redis.eval(
      CHECKOUT_LEASE_STATE_SCRIPT,
      [cartIndexKey(cartId)],
      [cartId, checkoutIdempotencyKey, now, MAX_CHECKOUT_PENDING_SECONDS * 1000],
    );
    const parsed = CheckoutLeaseStateService.parseScriptResult<RawCheckoutLeaseStateScriptResult>(
      raw,
      CHECKOUT_LEASE_STATE_SCRIPT_VERSION,
    );

    return {
      ok: true,
      found: CheckoutLeaseStateService.toBoolean(parsed.found, 'found'),
      complete: CheckoutLeaseStateService.toBoolean(parsed.complete, 'complete'),
      allOwnedByCheckoutKey: CheckoutLeaseStateService.toBoolean(
        parsed.allOwnedByCheckoutKey,
        'allOwnedByCheckoutKey',
      ),
      earliestCheckoutPendingAt: CheckoutLeaseStateService.toNullableNumber(
        parsed.earliestCheckoutPendingAt,
        'earliestCheckoutPendingAt',
      ),
      earliestCheckoutPendingExpiresAt: CheckoutLeaseStateService.toNullableNumber(
        parsed.earliestCheckoutPendingExpiresAt,
        'earliestCheckoutPendingExpiresAt',
      ),
      latestCheckoutPendingExpiresAt: CheckoutLeaseStateService.toNullableNumber(
        parsed.latestCheckoutPendingExpiresAt,
        'latestCheckoutPendingExpiresAt',
      ),
      pendingProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.pendingProductIds, 'pendingProductIds'),
      ),
      activeStatusProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.activeStatusProductIds, 'activeStatusProductIds'),
      ),
      missingProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.missingProductIds, 'missingProductIds'),
      ),
      malformedProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.malformedProductIds, 'malformedProductIds'),
      ),
      versionMismatchedProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(
          parsed.versionMismatchedProductIds,
          'versionMismatchedProductIds',
        ),
      ),
      conflictingKeyProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(
          parsed.conflictingKeyProductIds,
          'conflictingKeyProductIds',
        ),
      ),
      expiredLeaseProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.expiredLeaseProductIds, 'expiredLeaseProductIds'),
      ),
      hardLimitViolationProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(
          parsed.hardLimitViolationProductIds,
          'hardLimitViolationProductIds',
        ),
      ),
    };
  }

  async extendCheckoutLease(
    cartId: string,
    checkoutIdempotencyKey: string,
    now: number,
    additionalSeconds: number,
  ): Promise<CheckoutExtendLeaseResult> {
    const validationFailure = CheckoutLeaseStateService.validateExtendLeaseInputs(
      cartId,
      checkoutIdempotencyKey,
      now,
      additionalSeconds,
    );
    if (validationFailure) {
      return validationFailure;
    }

    const raw = await this.redis.eval(
      CHECKOUT_EXTEND_LEASE_SCRIPT,
      [cartIndexKey(cartId)],
      [cartId, checkoutIdempotencyKey, now, additionalSeconds * 1000, MAX_CHECKOUT_PENDING_SECONDS * 1000],
    );
    const parsed = CheckoutLeaseStateService.parseScriptResult<RawCheckoutExtendLeaseScriptResult>(
      raw,
      CHECKOUT_EXTEND_LEASE_SCRIPT_VERSION,
    );

    if (parsed.err) {
      return CheckoutLeaseStateService.mapExtendLeaseError(parsed);
    }

    return {
      ok: true,
      alreadyExtended: CheckoutLeaseStateService.toBoolean(parsed.alreadyExtended, 'alreadyExtended'),
      newCheckoutPendingExpiresAt: CheckoutLeaseStateService.toNumber(
        parsed.newCheckoutPendingExpiresAt,
        'newCheckoutPendingExpiresAt',
      ),
      extendedProductIds: CheckoutLeaseStateService.sortIds(
        CheckoutLeaseStateService.toStringArray(parsed.extendedProductIds, 'extendedProductIds'),
      ),
    };
  }

  private static mapExtendLeaseError(
    parsed: RawCheckoutExtendLeaseScriptResult,
  ): CheckoutExtendLeaseResult {
    switch (parsed.err) {
      case 'RESERVATION_NOT_PENDING':
        return { ok: false, code: 'RESERVATION_NOT_PENDING' };
      case 'CHECKOUT_STATE_INCOMPLETE':
        return {
          ok: false,
          code: 'CHECKOUT_STATE_INCOMPLETE',
          pendingProductIds: CheckoutLeaseStateService.sortIds(
            CheckoutLeaseStateService.toStringArray(parsed.pendingProductIds, 'pendingProductIds'),
          ),
          activeProductIds: CheckoutLeaseStateService.sortIds(
            CheckoutLeaseStateService.toStringArray(parsed.activeProductIds, 'activeProductIds'),
          ),
        };
      default:
        return {
          ok: false,
          code: parsed.err as CheckoutExtendLeaseErrorCode,
          productIds: CheckoutLeaseStateService.sortIds(
            CheckoutLeaseStateService.toStringArray(parsed.productIds, 'productIds'),
          ),
        };
    }
  }

  private static validateCartCheckoutKeyAndNow(
    cartId: string,
    checkoutIdempotencyKey: string,
    now: number,
  ): CheckoutInputValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(cartId, 'cartId');
    if (cartIdError) {
      return { ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: cartIdError };
    }

    if (checkoutIdempotencyKey.length === 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot be empty',
      };
    }
    if (/\s/.test(checkoutIdempotencyKey)) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot contain whitespace',
      };
    }

    if (!Number.isFinite(now) || now < 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now must be a finite, non-negative number',
      };
    }

    return null;
  }

  private static validateExtendLeaseInputs(
    cartId: string,
    checkoutIdempotencyKey: string,
    now: number,
    additionalSeconds: number,
  ): CheckoutInputValidationFailure | null {
    const baseFailure = CheckoutLeaseStateService.validateCartCheckoutKeyAndNow(
      cartId,
      checkoutIdempotencyKey,
      now,
    );
    if (baseFailure) {
      return baseFailure;
    }

    if (!Number.isInteger(additionalSeconds) || additionalSeconds <= 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'additionalSeconds',
        reason: 'additionalSeconds must be a positive integer',
      };
    }

    return null;
  }

  private static sortIds(ids: string[]): string[] {
    return [...ids].sort();
  }

  // Accepts exactly two shapes: a real array containing only strings, or a
  // bare empty object ({}) - the one documented cjson encoding of an empty
  // Lua table (see checkout-reservation-state.service.ts's identical
  // reasoning, deliberately reimplemented here rather than shared - see
  // the Unit 2.4.2 decision against extracting a shared utility for this
  // unit). Every other shape is an unexpected script-protocol failure.
  private static toStringArray(value: unknown, fieldName: string): string[] {
    if (Array.isArray(value)) {
      if (value.every((entry): entry is string => typeof entry === 'string')) {
        return value;
      }
      throw new Error(
        `Checkout script result field "${fieldName}" is an array containing non-string values`,
      );
    }
    if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
      return [];
    }
    throw new Error(`Checkout script result field "${fieldName}" has an unexpected shape`);
  }

  private static toBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    throw new Error(`Checkout script result field "${fieldName}" has an unexpected shape`);
  }

  private static toNumber(value: unknown, fieldName: string): number {
    if (typeof value === 'number') {
      return value;
    }
    throw new Error(`Checkout script result field "${fieldName}" has an unexpected shape`);
  }

  // A Lua nil-valued table field is omitted entirely by cjson.encode
  // rather than encoded as JSON null (see the comment in
  // checkout-lease-state-lua-scripts.ts) - `undefined` and `null` are
  // therefore treated identically here, both meaning "no timestamp".
  private static toNullableNumber(value: unknown, fieldName: string): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return value;
    }
    throw new Error(`Checkout script result field "${fieldName}" has an unexpected shape`);
  }

  // scriptVersion is required on every result either script returns.
  // Missing, non-numeric, or unsupported is treated as an unexpected
  // script-protocol failure - never mapped into a normal result - and
  // throws, matching CheckoutReservationStateService.parseScriptResult's
  // existing standard (reimplemented here, not imported, per the Unit
  // 2.4.2 decision to keep this service's protocol helpers local).
  private static parseScriptResult<T extends { scriptVersion?: unknown }>(
    raw: unknown,
    expectedVersion: number,
  ): T {
    if (typeof raw !== 'string') {
      throw new Error('Checkout script did not return a JSON string result');
    }
    const parsed = JSON.parse(raw) as T;
    if (typeof parsed.scriptVersion !== 'number') {
      throw new Error('Checkout script result is missing a numeric scriptVersion');
    }
    if (parsed.scriptVersion !== expectedVersion) {
      throw new Error(`Checkout script returned unsupported scriptVersion ${parsed.scriptVersion}`);
    }
    return parsed;
  }
}
