import { RESERVATION_ENTRY_VERSION } from '../constants/inventory.constants';
import type { CartScopedReservationEntry } from './inventory-reservations.service';

export type ReservationReadObservation =
  | { status: 'ACTIVE'; entry: CartScopedReservationEntry }
  | { status: 'ABSENT' }
  | { status: 'EXPIRED' }
  | { status: 'MALFORMED' }
  | { status: 'UNTRUSTED' };

export type ReservedTotalObservation =
  | { status: 'OK'; reservedByOthers: number }
  | { status: 'SUSPECT' };

// Pure, bounded observation. No raw payload or unknown fields escape this
// boundary. Transport errors belong to the caller and are never absence.
export function observeReservation(raw: string | null, cartId: string, now: number): ReservationReadObservation {
  if (raw === null) return { status: 'ABSENT' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'MALFORMED' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'MALFORMED' };
  const r = parsed as Record<string, unknown>;
  if (r.version !== RESERVATION_ENTRY_VERSION) return { status: 'UNTRUSTED' };
  if (r.cartId !== cartId || typeof r.customerId !== 'string' || !r.customerId.length ||
    (r.status !== 'ACTIVE' && r.status !== 'CHECKOUT_PENDING')) return { status: 'UNTRUSTED' };
  const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (typeof r.quantity !== 'number' || !Number.isSafeInteger(r.quantity) || r.quantity <= 0 ||
    !timestamp(r.createdAt) || !timestamp(r.lastRenewedAt) || !timestamp(r.expiresAt) || !timestamp(r.absoluteExpiresAt) ||
    r.lastRenewedAt < r.createdAt || r.expiresAt > r.absoluteExpiresAt) return { status: 'MALFORMED' };
  if (r.status === 'ACTIVE' ?
    r.checkoutIdempotencyKey !== null || r.checkoutPendingAt !== null || r.checkoutPendingExpiresAt !== null :
    typeof r.checkoutIdempotencyKey !== 'string' || !r.checkoutIdempotencyKey.length ||
      !timestamp(r.checkoutPendingAt) || !timestamp(r.checkoutPendingExpiresAt) ||
      r.checkoutPendingExpiresAt < r.checkoutPendingAt) return { status: 'UNTRUSTED' };
  if (r.expiresAt <= now || r.absoluteExpiresAt <= now) return { status: 'EXPIRED' };
  return { status: 'ACTIVE', entry: {
    version: RESERVATION_ENTRY_VERSION, quantity: r.quantity, cartId, customerId: r.customerId,
    status: r.status, createdAt: r.createdAt, lastRenewedAt: r.lastRenewedAt,
    expiresAt: r.expiresAt, absoluteExpiresAt: r.absoluteExpiresAt,
    checkoutIdempotencyKey: r.checkoutIdempotencyKey as string | null,
    checkoutPendingAt: r.checkoutPendingAt as number | null,
    checkoutPendingExpiresAt: r.checkoutPendingExpiresAt as number | null,
  } };
}
