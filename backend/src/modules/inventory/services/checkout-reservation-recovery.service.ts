import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import { cartIndexKey, getReservationKeySegmentValidationError } from '../constants/inventory.constants';
import { FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT } from '../lua/checkout-finalize-lua-scripts';
import {
  CheckoutInputValidationFailure,
  FinalizeCheckoutConsumptionOutcome,
} from './checkout-reservation-state.types';
import { ReservationUnderflowDetails } from './reservation-accounting.types';

// Script-identity protocol versions, one per script, deliberately not
// shared with the sibling checkout-state services' own constants - see
// the Unit 2.4.3 decision to leave duplicated protocol helpers local
// rather than extract a shared production utility (a later cleanup
// commit may consolidate them once every checkout-state unit is stable).
const FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT_VERSION = 1;

interface RawUnderflowEntry {
  productId?: unknown;
  reservationQuantity?: unknown;
  storedTotal?: unknown;
}

interface RawFinalizeCheckoutConsumptionScriptResult {
  scriptVersion?: unknown;
  ok?: true;
  finalizedProductIds?: unknown;
  skippedProductIds?: unknown;
  malformedProductIds?: unknown;
  versionMismatchedProductIds?: unknown;
  underflow?: unknown;
  admissionSuspended?: unknown;
}

// Deferred finalize compatibility only. Raw revert is not a production API.
@Injectable()
export class CheckoutReservationRecoveryService {
  constructor(private readonly redis: RedisService) {}

  async finalizeCheckoutConsumption(
    cartId: string,
    checkoutIdempotencyKey: string,
  ): Promise<FinalizeCheckoutConsumptionOutcome> {
    const validationFailure = CheckoutReservationRecoveryService.validateCartAndCheckoutKey(
      cartId,
      checkoutIdempotencyKey,
    );
    if (validationFailure) {
      return validationFailure;
    }

    const now = Date.now();
    const raw = await this.redis.eval(
      FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT,
      [cartIndexKey(cartId)],
      [cartId, checkoutIdempotencyKey],
    );
    const parsed =
      CheckoutReservationRecoveryService.parseScriptResult<RawFinalizeCheckoutConsumptionScriptResult>(
        raw,
        FINALIZE_CHECKOUT_CONSUMPTION_SCRIPT_VERSION,
      );

    return {
      ok: true,
      finalizedProductIds: CheckoutReservationRecoveryService.sortIds(
        CheckoutReservationRecoveryService.toStringArray(
          parsed.finalizedProductIds,
          'finalizedProductIds',
        ),
      ),
      skippedProductIds: CheckoutReservationRecoveryService.sortIds(
        CheckoutReservationRecoveryService.toStringArray(parsed.skippedProductIds, 'skippedProductIds'),
      ),
      malformedProductIds: CheckoutReservationRecoveryService.sortIds(
        CheckoutReservationRecoveryService.toStringArray(
          parsed.malformedProductIds,
          'malformedProductIds',
        ),
      ),
      versionMismatchedProductIds: CheckoutReservationRecoveryService.sortIds(
        CheckoutReservationRecoveryService.toStringArray(
          parsed.versionMismatchedProductIds,
          'versionMismatchedProductIds',
        ),
      ),
      underflow: CheckoutReservationRecoveryService.sortUnderflow(
        CheckoutReservationRecoveryService.toUnderflowArray(
          parsed.underflow,
          'underflow',
          cartId,
          'finalizeCheckoutConsumption',
          now,
        ),
      ),
      admissionSuspended: CheckoutReservationRecoveryService.toBoolean(
        parsed.admissionSuspended,
        'admissionSuspended',
      ),
    };
  }

  private static validateCartAndCheckoutKey(
    cartId: string,
    checkoutIdempotencyKey: string,
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

    return null;
  }

  private static sortIds(ids: string[]): string[] {
    return [...ids].sort();
  }

  private static sortUnderflow(
    details: ReservationUnderflowDetails[],
  ): ReservationUnderflowDetails[] {
    return [...details].sort((a, b) => a.productId.localeCompare(b.productId));
  }

  // Accepts exactly two shapes: a real array containing only strings, or a
  // bare empty object ({}) - the one documented cjson encoding of an empty
  // Lua table (confirmed by direct probing in Unit 2.4.1 against this
  // repository's Redis instance). Every other shape is an unexpected
  // script-protocol failure and throws, rather than being silently
  // treated as "no entries".
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

  // Same two-shape acceptance rule as toStringArray, adapted for an array
  // of underflow entries. Each element is validated structurally before
  // being widened into the full ReservationUnderflowDetails shape by
  // attaching cartId/operationName/timestamp - the caller-supplied context
  // for a detail the script itself has no way to know.
  private static toUnderflowArray(
    value: unknown,
    fieldName: string,
    cartId: string,
    operationName: ReservationUnderflowDetails['operationName'],
    timestamp: number,
  ): ReservationUnderflowDetails[] {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        const candidate = entry as RawUnderflowEntry;
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          typeof candidate.productId !== 'string' ||
          typeof candidate.reservationQuantity !== 'number' ||
          typeof candidate.storedTotal !== 'number'
        ) {
          throw new Error(
            `Checkout script result field "${fieldName}[${index}]" has an unexpected shape`,
          );
        }
        return {
          productId: candidate.productId,
          cartId,
          reservationQuantity: candidate.reservationQuantity,
          storedTotal: candidate.storedTotal,
          operationName,
          timestamp,
        };
      });
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

  // scriptVersion is required on every result either script returns.
  // Missing, non-numeric, or unsupported is treated as an unexpected
  // script-protocol failure - never mapped into a normal result - and
  // throws, matching the standard already established by
  // CheckoutReservationStateService/CheckoutLeaseStateService.
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
