// A cart's soft hold on stock lasts this long before it's treated as
// expired and no longer counted against other shoppers' availability.
export const RESERVATION_TTL_SECONDS = 900;

// Defensive outer TTL on the Redis hash key itself, so abandoned/
// discontinued products' reservation hashes eventually get reclaimed even
// though correctness never depends on this (every read prunes expired
// entries by their own `expiresAt` field, not Redis's key-level TTL).
export const RESERVATION_HASH_TTL_SECONDS = RESERVATION_TTL_SECONDS * 2;

export function reservationHashKey(productId: string): string {
  return `inv:reserved:${productId}`;
}

// Cart-scoped reservation model (see
// docs/architecture/reservation-lifecycle.md). RESERVATION_TTL_SECONDS
// above is reused unchanged - the rolling TTL is the same concept and
// value for both the legacy and current key formats.
export const RESERVATION_ENTRY_VERSION = 1;
export const MAX_RESERVATION_LIFETIME_SECONDS = 3600;
export const CHECKOUT_PENDING_INITIAL_LEASE_SECONDS = 180;
export const MAX_CHECKOUT_PENDING_SECONDS = 600;

// The `{cartId}` hash tag groups every reservation key for one cart onto
// the same Redis Cluster slot (see reservation-lifecycle.md §1) - the
// current deployment is a single non-cluster instance, so this has no
// operational effect today.
export function reservationKey(cartId: string, productId: string): string {
  assertValidReservationKeySegment(cartId, 'cartId');
  assertValidReservationKeySegment(productId, 'productId');
  return `inv:reserved:{${cartId}}:${productId}`;
}

function assertValidReservationKeySegment(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  if (/\s/.test(value)) {
    throw new Error(`${label} cannot contain whitespace`);
  }
  if (value.includes('{') || value.includes('}') || value.includes(':')) {
    throw new Error(`${label} cannot contain '{', '}', or ':'`);
  }
}

const LEGACY_RESERVATION_KEY_PATTERN = /^inv:reserved:[^{}:\s]+$/;
const CURRENT_RESERVATION_KEY_PATTERN = /^inv:reserved:\{[^{}:\s]+\}:[^{}:\s]+$/;

export function isLegacyReservationKey(key: string): boolean {
  return LEGACY_RESERVATION_KEY_PATTERN.test(key);
}

export function isCurrentReservationKey(key: string): boolean {
  return CURRENT_RESERVATION_KEY_PATTERN.test(key);
}

// Secondary structures maintained atomically alongside every cart-scoped
// reservation entry (see docs/architecture/reservation-lifecycle.md §4).
export function cartIndexKey(cartId: string): string {
  assertValidReservationKeySegment(cartId, 'cartId');
  return `inv:reserved:cart-index:{${cartId}}`;
}

export function productIndexKey(productId: string): string {
  assertValidReservationKeySegment(productId, 'productId');
  return `inv:reserved:product-index:{${productId}}`;
}

export function productTotalKey(productId: string): string {
  assertValidReservationKeySegment(productId, 'productId');
  return `inv:reserved:product-total:{${productId}}`;
}

export function productSuspectKey(productId: string): string {
  assertValidReservationKeySegment(productId, 'productId');
  return `inv:reserved:product-total-suspect:{${productId}}`;
}
