import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import { Redis } from 'ioredis';

import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../constants/inventory.constants';

dotenv.config();

// Shared plumbing for the real-Redis integration specs
// (inventory-reservations.redis.integration.spec.ts and
// inventory-reservations-reconciliation.redis.integration.spec.ts). No
// assertions or business scenarios belong in this file - only unique ID
// generation, client construction, created-key tracking/cleanup, and raw
// Redis-state access helpers.

export interface TestIds {
  cartId: string;
  productId: string;
  customerId: string;
}

export function ids(): TestIds {
  return { cartId: randomUUID(), productId: randomUUID(), customerId: randomUUID() };
}

export async function connectRealRedis(): Promise<Redis> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      'REDIS_URL is not configured - this suite requires a real Redis instance and does not skip.',
    );
  }

  const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw new Error(
      `Real Redis is unavailable at ${redisUrl} - this suite requires a running Redis instance and does not skip: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return client;
}

export function trackKeysFor(createdKeys: Set<string>, cartId: string, productId: string): void {
  createdKeys.add(reservationKey(cartId, productId));
  createdKeys.add(cartIndexKey(cartId));
  createdKeys.add(productIndexKey(productId));
  createdKeys.add(productTotalKey(productId));
  createdKeys.add(productSuspectKey(productId));
}

export async function cleanupKeys(client: Redis, createdKeys: Set<string>): Promise<void> {
  if (createdKeys.size > 0) {
    await client.del(...Array.from(createdKeys));
  }
}

export async function getRawReservation(
  client: Redis,
  cartId: string,
  productId: string,
): Promise<string | null> {
  return client.get(reservationKey(cartId, productId));
}

export async function getCartIndexMembers(client: Redis, cartId: string): Promise<string[]> {
  return client.smembers(cartIndexKey(cartId));
}

export async function getProductIndexMembers(client: Redis, productId: string): Promise<string[]> {
  return client.smembers(productIndexKey(productId));
}

export async function getStoredTotal(client: Redis, productId: string): Promise<string | null> {
  return client.get(productTotalKey(productId));
}

export async function getSuspectFlag(client: Redis, productId: string): Promise<string | null> {
  return client.get(productSuspectKey(productId));
}
