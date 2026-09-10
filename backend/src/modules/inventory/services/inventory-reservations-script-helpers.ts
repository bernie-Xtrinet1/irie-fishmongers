import { Logger } from '@nestjs/common';

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
