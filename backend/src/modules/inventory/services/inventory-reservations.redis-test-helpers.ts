import { randomUUID } from 'crypto';
import * as dotenv from 'dotenv';
import type { ReservationEngineMode } from '@prisma/client';
import { Redis } from 'ioredis';

import {
  cartIndexKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from '../constants/inventory.constants';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';

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

// Historical, pre-fence inventory for legacy checkout/recovery tests only.
// This is fixture construction, not proof of current W1 authorization.
export async function seedHistoricalActiveReservation(
  client: Redis, cartId: string, productId: string, customerId: string, quantity: number, ttlMs = 900000,
): Promise<void> {
  const now = Date.now();
  if (await client.exists(reservationKey(cartId, productId))) throw new Error('Historical fixture already exists');
  await client.set(reservationKey(cartId, productId), JSON.stringify({ version: 1, cartId, customerId, quantity,
    status: 'ACTIVE', createdAt: now, lastRenewedAt: now, expiresAt: now + ttlMs, absoluteExpiresAt: now + Math.max(3600000, ttlMs),
    checkoutIdempotencyKey: null, checkoutPendingAt: null, checkoutPendingExpiresAt: null }));
  await client.sadd(cartIndexKey(cartId), productId);
  await client.sadd(productIndexKey(productId), cartId);
  await client.incrby(productTotalKey(productId), quantity);
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

export async function ensureOpenReservationFence(
  prisma: any,
  redisClient: Redis,
  targetMode: ReservationEngineMode,
  actorId: string,
): Promise<void> {
  let mode = await prisma.reservationEngineModeConfig.findFirst({
    orderBy: { revision: 'desc' },
  });
  if (!mode || mode.mode !== targetMode) {
    mode = await prisma.reservationEngineModeConfig.create({
      data: { mode: targetMode, updatedById: actorId },
    });
  }

  let fence = await prisma.reservationFenceTransition.findFirst({
    where: {
      status: 'ACKNOWLEDGED',
      phase: 'OPEN',
      mode: targetMode,
      modeRevision: mode.revision,
    },
    orderBy: { revision: 'desc' },
  });

  if (!fence) {
    const maxFence = await prisma.reservationFenceTransition.findFirst({
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    const nextRevision = (maxFence?.revision ?? 0) + 1;
    fence = await prisma.reservationFenceTransition.create({
      data: {
        incarnation: randomUUID(),
        epoch: 1,
        revision: nextRevision,
        phase: 'OPEN',
        protocol: 1,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        mode: targetMode,
        modeRevision: mode.revision,
        reason: 'OPEN',
        actorId,
      },
    });
  }

  await redisClient.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
  await redisClient.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
}
