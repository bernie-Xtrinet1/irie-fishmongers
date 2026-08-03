import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import {
  MAX_CHECKOUT_PENDING_SECONDS,
  cartIndexKey,
  getReservationKeySegmentValidationError,
  productSuspectKey,
  reservationKey,
} from '../constants/inventory.constants';
import { CHECKOUT_MARK_SCRIPT } from '../lua/checkout-mark-lua-scripts';
import {
  CheckoutInputValidationFailure,
  CheckoutMarkErrorCode,
  CheckoutMarkResult,
  CheckoutPlanMismatchDetails,
  CheckoutReservationPlanItem,
} from './checkout-reservation-state.types';

// The version this service expects CHECKOUT_MARK_SCRIPT to declare itself
// as. Kept separate from the Lua-internal SUPPORTED_VERSION (which governs
// which ReservationEntry.version values the script accepts) - this is a
// protocol check on the *script's own* declared identity, not on entry
// data. See checkout-mark-lua-scripts.ts.
const CHECKOUT_MARK_SCRIPT_VERSION = 1;

// Array-typed fields are declared `unknown`, not `string[]`, because
// Redis's embedded cjson encodes an *empty* Lua table as a JSON object
// ({}), not an array ([]) - confirmed by direct probing against this
// repository's Redis instance; no portable cjson-side fix exists (neither
// cjson.array_mt nor encode_empty_table_as_object is available in this
// Redis's Lua environment). CheckoutReservationStateService.toStringArray
// accepts exactly that one documented shape (a bare empty object) as "no
// entries" - every other non-string-array shape is treated as a
// script-protocol failure, not silently coerced to an empty array.
interface RawCheckoutMarkScriptResult {
  scriptVersion?: unknown;
  ok?: true;
  err?: string;
  failedProductId?: string;
  duplicateProductIds?: unknown;
  submittedProductIds?: unknown;
  indexedProductIds?: unknown;
  missingFromPlan?: unknown;
  missingFromIndex?: unknown;
  suspectProductIds?: unknown;
}

// Owns whole-cart checkout reservation-state operations (see
// docs/architecture/reservation-lifecycle.md §7-9). Additive and not wired
// to any caller - CartService/OrdersService remain untouched. Per-item
// reservation accounting (reserveOrRenew, releaseReservation, etc.) stays
// on InventoryReservationsService; this service never duplicates that
// logic, only orchestrates whole-cart Lua scripts of its own.
@Injectable()
export class CheckoutReservationStateService {
  private readonly logger = new Logger(CheckoutReservationStateService.name);

  constructor(private readonly redis: RedisService) {}

  async checkoutMark(
    cartId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    items: CheckoutReservationPlanItem[],
    now: number,
    initialLeaseSeconds: number,
  ): Promise<CheckoutMarkResult> {
    const validationFailure = CheckoutReservationStateService.validateCheckoutMarkInputs(
      cartId,
      customerId,
      checkoutIdempotencyKey,
      items,
      now,
      initialLeaseSeconds,
    );
    if (validationFailure) {
      return validationFailure;
    }

    const keys = [
      cartIndexKey(cartId),
      ...items.map((item) => reservationKey(cartId, item.productId)),
      ...items.map((item) => productSuspectKey(item.productId)),
    ];
    const args: (string | number)[] = [
      cartId,
      customerId,
      checkoutIdempotencyKey,
      now,
      initialLeaseSeconds * 1000,
      MAX_CHECKOUT_PENDING_SECONDS * 1000,
      items.length,
      ...items.map((item) => item.productId),
      ...items.map((item) => item.expectedQuantity),
    ];

    const raw = await this.redis.eval(CHECKOUT_MARK_SCRIPT, keys, args);
    const parsed =
      CheckoutReservationStateService.parseScriptResult<RawCheckoutMarkScriptResult>(raw);

    if (parsed.err) {
      return CheckoutReservationStateService.mapCheckoutMarkError(parsed);
    }

    const suspectProductIds = CheckoutReservationStateService.sortIds(
      CheckoutReservationStateService.toStringArray(parsed.suspectProductIds, 'suspectProductIds'),
    );
    if (suspectProductIds.length > 0) {
      // Informational only - a suspect product never blocks checkoutMark
      // (see docs/architecture/reservation-lifecycle.md and the Unit
      // 16A.0 planning decisions). Logged for monitoring/future policy.
      this.logger.warn('checkoutMark completed against suspect product(s)', {
        cartId,
        checkoutIdempotencyKey,
        suspectProductIds,
      });
    }

    return { ok: true, suspectProductIds };
  }

  private static mapCheckoutMarkError(parsed: RawCheckoutMarkScriptResult): CheckoutMarkResult {
    switch (parsed.err) {
      case 'CHECKOUT_PLAN_EMPTY':
        return { ok: false, code: 'CHECKOUT_PLAN_EMPTY' };
      case 'CHECKOUT_PLAN_DUPLICATE_PRODUCT':
        return {
          ok: false,
          code: 'CHECKOUT_PLAN_DUPLICATE_PRODUCT',
          duplicateProductIds: CheckoutReservationStateService.sortIds(
            CheckoutReservationStateService.toStringArray(
              parsed.duplicateProductIds,
              'duplicateProductIds',
            ),
          ),
        };
      case 'CHECKOUT_PLAN_MISMATCH': {
        const details: CheckoutPlanMismatchDetails = {
          submittedProductIds: CheckoutReservationStateService.sortIds(
            CheckoutReservationStateService.toStringArray(
              parsed.submittedProductIds,
              'submittedProductIds',
            ),
          ),
          indexedProductIds: CheckoutReservationStateService.sortIds(
            CheckoutReservationStateService.toStringArray(
              parsed.indexedProductIds,
              'indexedProductIds',
            ),
          ),
          missingFromPlan: CheckoutReservationStateService.sortIds(
            CheckoutReservationStateService.toStringArray(parsed.missingFromPlan, 'missingFromPlan'),
          ),
          missingFromIndex: CheckoutReservationStateService.sortIds(
            CheckoutReservationStateService.toStringArray(
              parsed.missingFromIndex,
              'missingFromIndex',
            ),
          ),
          duplicateProductIds: [],
        };
        return { ok: false, code: 'CHECKOUT_PLAN_MISMATCH', details };
      }
      default:
        return {
          ok: false,
          code: parsed.err as CheckoutMarkErrorCode,
          failedProductId: parsed.failedProductId ?? '',
        };
    }
  }

  private static validateCheckoutMarkInputs(
    cartId: string,
    customerId: string,
    checkoutIdempotencyKey: string,
    items: CheckoutReservationPlanItem[],
    now: number,
    initialLeaseSeconds: number | undefined,
  ): CheckoutInputValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(cartId, 'cartId');
    if (cartIdError) {
      return { ok: false, code: 'INVALID_INPUT', field: 'cartId', reason: cartIdError };
    }

    const customerIdError = getReservationKeySegmentValidationError(customerId, 'customerId');
    if (customerIdError) {
      return { ok: false, code: 'INVALID_INPUT', field: 'customerId', reason: customerIdError };
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

    if (items.length === 0) {
      return { ok: false, code: 'INVALID_INPUT', field: 'items', reason: 'items cannot be empty' };
    }

    for (const item of items) {
      const productIdError = getReservationKeySegmentValidationError(item.productId, 'productId');
      if (productIdError) {
        return { ok: false, code: 'INVALID_INPUT', field: 'productId', reason: productIdError };
      }
      if (!Number.isInteger(item.expectedQuantity) || item.expectedQuantity <= 0) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          field: 'expectedQuantity',
          reason: 'expectedQuantity must be a positive integer',
        };
      }
    }

    if (!Number.isFinite(now) || now < 0) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now must be a finite, non-negative number',
      };
    }

    if (
      initialLeaseSeconds !== undefined &&
      (!Number.isInteger(initialLeaseSeconds) || initialLeaseSeconds <= 0)
    ) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'initialLeaseSeconds',
        reason: 'initialLeaseSeconds must be a positive integer',
      };
    }

    return null;
  }

  private static sortIds(ids: string[]): string[] {
    return [...ids].sort();
  }

  // Accepts exactly two shapes for a script-provided array field: a real
  // array containing only strings, or a bare empty object ({}) - the one
  // documented cjson encoding of an empty Lua table (see the comment on
  // RawCheckoutMarkScriptResult). Every other shape (a non-empty object, a
  // string, a number, a boolean, null, or an array containing a
  // non-string) is an unexpected script-protocol failure and throws,
  // rather than being silently treated as "no entries".
  private static toStringArray(value: unknown, fieldName: string): string[] {
    if (Array.isArray(value)) {
      if (value.every((entry): entry is string => typeof entry === 'string')) {
        return value;
      }
      throw new Error(
        `Checkout script result field "${fieldName}" is an array containing non-string values`,
      );
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 0
    ) {
      return [];
    }
    throw new Error(`Checkout script result field "${fieldName}" has an unexpected shape`);
  }

  // scriptVersion is required on every result CHECKOUT_MARK_SCRIPT
  // returns. A missing, non-numeric, or unsupported scriptVersion is
  // treated as an unexpected script-protocol failure - never mapped into
  // a normal CheckoutMarkResult - and throws, matching this repository's
  // existing standard for infrastructure-level script failures (see
  // InventoryReservationsService.parseScriptResult).
  private static parseScriptResult<T extends { scriptVersion?: unknown }>(raw: unknown): T {
    if (typeof raw !== 'string') {
      throw new Error('Checkout script did not return a JSON string result');
    }
    const parsed = JSON.parse(raw) as T;
    if (typeof parsed.scriptVersion !== 'number') {
      throw new Error('Checkout script result is missing a numeric scriptVersion');
    }
    if (parsed.scriptVersion !== CHECKOUT_MARK_SCRIPT_VERSION) {
      throw new Error(`Checkout script returned unsupported scriptVersion ${parsed.scriptVersion}`);
    }
    return parsed;
  }
}
