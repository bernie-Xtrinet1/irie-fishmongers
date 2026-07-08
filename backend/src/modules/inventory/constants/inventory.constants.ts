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
