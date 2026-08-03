import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

import { cartIndexKey, productSuspectKey, reservationKey } from '../constants/inventory.constants';
import { CheckoutReservationPlanItem } from './checkout-reservation-state.types';

// Checkout-specific real-Redis test plumbing only. Real Redis client
// setup/teardown (connectRealRedis/cleanupKeys) is reused directly from
// inventory-reservations.redis-test-helpers.ts, not duplicated here - this
// file adds only what checkoutMark's integration tests need beyond that:
// unique checkout ids, plan construction, checkout-field readers, and raw
// seeding for malformed/version-mismatch scenarios that InventoryReservationsService
// itself cannot produce. No assertions or business scenarios belong here.

export interface CheckoutTestIds {
  cartId: string;
  customerId: string;
  checkoutIdempotencyKey: string;
}

export function checkoutIds(): CheckoutTestIds {
  return {
    cartId: randomUUID(),
    customerId: randomUUID(),
    checkoutIdempotencyKey: randomUUID(),
  };
}

export function buildPlan(
  productIds: string[],
  quantityByProductId: Record<string, number>,
): CheckoutReservationPlanItem[] {
  return productIds.map((productId) => {
    const expectedQuantity = quantityByProductId[productId];
    if (expectedQuantity === undefined) {
      throw new Error(`buildPlan: no quantity supplied for productId ${productId}`);
    }
    return { productId, expectedQuantity };
  });
}

export function trackCheckoutKeysFor(
  createdKeys: Set<string>,
  cartId: string,
  productIds: string[],
): void {
  createdKeys.add(cartIndexKey(cartId));
  for (const productId of productIds) {
    createdKeys.add(reservationKey(cartId, productId));
    createdKeys.add(productSuspectKey(productId));
  }
}

export interface RawCheckoutFields {
  status: string;
  checkoutIdempotencyKey: string | null;
  checkoutPendingAt: number | null;
  checkoutPendingExpiresAt: number | null;
  quantity: number;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export async function getRawCheckoutFields(
  client: Redis,
  cartId: string,
  productId: string,
): Promise<RawCheckoutFields | null> {
  const raw = await client.get(reservationKey(cartId, productId));
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as RawCheckoutFields;
}

export async function getRawReservationValue(
  client: Redis,
  cartId: string,
  productId: string,
): Promise<string | null> {
  return client.get(reservationKey(cartId, productId));
}

// Writes an arbitrary raw value directly (bypassing InventoryReservationsService,
// which cannot itself produce a malformed/version-mismatched entry) and
// indexes it, matching what a real corrupted-but-indexed entry looks like.
export async function seedRawReservation(
  client: Redis,
  cartId: string,
  productId: string,
  rawValue: string,
): Promise<void> {
  await client.set(reservationKey(cartId, productId), rawValue);
  await client.sadd(cartIndexKey(cartId), productId);
}

export async function setSuspectFlag(client: Redis, productId: string): Promise<void> {
  await client.set(productSuspectKey(productId), '1');
}
