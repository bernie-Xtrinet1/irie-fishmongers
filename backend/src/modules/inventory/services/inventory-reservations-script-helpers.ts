import { Logger } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import { productSuspectKey } from '../constants/inventory.constants';
import { ReservationUnderflowDetails } from './reservation-accounting.types';

// Shared script-result plumbing for InventoryReservationsService's
// cart-scoped model - split out purely to keep the service file within the
// repository's 400-line file limit, with no change to any behavior. Every
// function here is called from exactly one place in
// inventory-reservations.service.ts.

export interface RawScriptUnderflow {
  reservationQuantity: number;
  storedTotal: number;
}

export function parseScriptResult<T>(raw: unknown): T {
  if (typeof raw !== 'string') {
    throw new Error('Reservation script did not return a JSON string result');
  }
  return JSON.parse(raw) as T;
}

// A malformed entry (unparseable JSON, an unexpected `version`, or a
// non-positive `quantity`) is never treated as a plain "no reservation"
// case the way a missing or expired key is - its quantity cannot be
// trusted, so it must not silently decrement the product total, and must
// not be inferred as safe to delete. It is left in place (for
// diagnostics/reconciliation) and the product is suspended for new
// admission until reconciliation repairs the total from the product index
// directly.
export async function flagMalformedReservation(
  redis: RedisService,
  logger: Logger,
  productId: string,
  cartId: string,
  reason: string,
  raw: string,
  observedVersion?: number,
): Promise<void> {
  await redis.set(productSuspectKey(productId), '1');
  logger.error(`Malformed reservation entry detected (${reason})`, {
    productId,
    cartId,
    reason,
    observedVersion,
    raw,
    timestamp: Date.now(),
  });
}

export function toUnderflowDetails(
  logger: Logger,
  raw: RawScriptUnderflow | null | undefined,
  context: {
    productId: string;
    cartId: string;
    operationName: 'reserveOrRenew' | 'releaseReservation';
    timestamp: number;
  },
): ReservationUnderflowDetails | null {
  if (!raw) {
    return null;
  }
  const details: ReservationUnderflowDetails = {
    productId: context.productId,
    cartId: context.cartId,
    reservationQuantity: raw.reservationQuantity,
    storedTotal: raw.storedTotal,
    operationName: context.operationName,
    timestamp: context.timestamp,
  };
  logger.warn(`RESERVATION_TOTAL_UNDERFLOW during ${context.operationName}`, details);
  return details;
}
