import { Redis } from 'ioredis';

import { RedisService } from '../../../common/redis/redis.service';
import { productSuspectKey } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis, ids } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { ReservationEngineModeService } from './reservation-engine-mode.service';
import { ReservationAvailabilityService } from './reservation-availability.service';

// Real-Redis integration coverage for ReservationAvailabilityService (Phase
// 16A.0-C2). The unit suite (reservation-availability.service.spec.ts) mocks
// InventoryReservationsService entirely and can only verify routing logic;
// it cannot prove the real legacy hash model and the real cart-scoped Lua
// scripts produce the exact numbers this service depends on, or that this
// service never mutates Redis. This suite requires a reachable Redis
// (REDIS_URL) and fails loudly rather than skipping - same convention as
// every other real-Redis spec in this codebase.
//
// ReservationEngineModeService is mocked here (getCurrentMode only) -
// mode-transition mechanics (Postgres advisory lock, rollback gate) are
// already covered by reservation-engine-mode.service.spec.ts and
// reservation-engine-mode-rollback.redis.integration.spec.ts; this file
// exists to prove ReservationAvailabilityService's own arithmetic and
// read-only guarantee against genuine Redis state.
//
// Test isolation - same dedicated logical Redis DB (1) and per-test
// FLUSHDB convention established by
// reservation-engine-mode-rollback.redis.integration.spec.ts, for the same
// reason: this suite must not depend on, or add to, the shared ambient DB
// 0's known leftover inv:reserved:* keys.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 1;

async function snapshotKeyspace(client: Redis): Promise<Record<string, unknown>> {
  const keys = (await client.keys('*')).sort();
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const type = await client.type(key);
    if (type === 'string') {
      snapshot[key] = await client.get(key);
    } else if (type === 'hash') {
      snapshot[key] = await client.hgetall(key);
    } else if (type === 'set') {
      snapshot[key] = (await client.smembers(key)).sort();
    } else {
      snapshot[key] = `unexpected-type:${type}`;
    }
  }
  return snapshot;
}

describe('ReservationAvailabilityService (real Redis integration)', () => {
  let client: Redis;
  let inventoryReservations: InventoryReservationsService;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let service: ReservationAvailabilityService;

  function setMode(mode: 'LEGACY' | 'MIRROR' | 'CART_SCOPED' | 'DRAINING'): void {
    modeService.getCurrentMode.mockResolvedValue(mode);
  }

  beforeAll(async () => {
    client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
  });

  afterAll(async () => {
    await client.flushdb();
    await client.quit();
  });

  beforeEach(async () => {
    await client.flushdb();
    inventoryReservations = new InventoryReservationsService(new RedisService(client));
    modeService = { getCurrentMode: jest.fn() };
    service = new ReservationAvailabilityService(
      modeService as unknown as ReservationEngineModeService,
      inventoryReservations,
    );
  });

  it('1. LEGACY: subtracts a real legacy-only hold from quantityAvailable', async () => {
    const { productId } = ids();
    setMode('LEGACY');
    await inventoryReservations.reserve(productId, 'cart-other', 4);

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result).toEqual({ ok: true, mode: 'LEGACY', source: 'LEGACY', available: 6 });
  });

  it('2. MIRROR: a mirrored duplicate hold (legacy + new engine) is subtracted once, never twice', async () => {
    const { productId, customerId } = ids();
    setMode('MIRROR');
    // Simulates MIRROR's dual-write for the same logical hold: the same
    // quantity is present in both the legacy hash and the cart-scoped
    // model.
    await inventoryReservations.reserve(productId, 'cart-other', 3);
    await inventoryReservations.reserveOrRenew('cart-other', productId, customerId, 3);

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'MIRROR') {
      expect(result.available).toBe(7);
    }
  });

  it('3. MIRROR: comparison reports AVAILABLE with the real new-engine number', async () => {
    const { productId, customerId } = ids();
    setMode('MIRROR');
    await inventoryReservations.reserveOrRenew('cart-a', productId, customerId, 5);

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'MIRROR') {
      expect(result.mirrorComparison).toEqual({ status: 'AVAILABLE', available: 5 });
    }
  });

  it('4. MIRROR: a real suspect flag produces STRUCTURE_DRIFT_CONFIRMED without affecting real available', async () => {
    const { productId } = ids();
    setMode('MIRROR');
    await inventoryReservations.reserve(productId, 'cart-other', 4);
    await client.set(productSuspectKey(productId), '1');

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'MIRROR') {
      expect(result.available).toBe(6);
      expect(result.mirrorComparison).toEqual({ status: 'STRUCTURE_DRIFT_CONFIRMED' });
    }
  });

  it('5. MIRROR: a comparison read failure produces COMPARISON_UNAVAILABLE without affecting real available', async () => {
    const { productId } = ids();
    setMode('MIRROR');
    await inventoryReservations.reserve(productId, 'cart-other', 4);
    jest
      .spyOn(inventoryReservations, 'getAvailabilityWithSuspectStatus')
      .mockRejectedValueOnce(new Error('simulated infrastructure failure'));

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'MIRROR') {
      expect(result.available).toBe(6);
      expect(result.mirrorComparison).toEqual({ status: 'COMPARISON_UNAVAILABLE' });
    }
  });

  it('6. CART_SCOPED: uses a real new-engine-only hold, never legacy', async () => {
    const { productId, customerId } = ids();
    setMode('CART_SCOPED');
    await inventoryReservations.reserveOrRenew('cart-other', productId, customerId, 4);

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result).toEqual({ ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 6 });
  });

  it('7. CART_SCOPED: applies the requesting cart’s own-cart add-back', async () => {
    const { cartId, productId, customerId } = ids();
    setMode('CART_SCOPED');
    await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 3);
    await inventoryReservations.reserveOrRenew('cart-other', productId, customerId, 2);

    const result = await service.getCartAdmissionAvailability(productId, 10, cartId);

    // quantityAvailable(10) - reservedByOthers(2) = 8; the requesting
    // cart's own 3 is excluded, not double-subtracted.
    expect(result).toEqual({ ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: 8 });
  });

  it('8. CART_SCOPED: a real suspect flag fails closed with RESERVATION_STRUCTURE_DRIFT', async () => {
    const { productId, customerId } = ids();
    setMode('CART_SCOPED');
    await inventoryReservations.reserveOrRenew('cart-other', productId, customerId, 4);
    await client.set(productSuspectKey(productId), '1');

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result).toEqual({ ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' });
  });

  it('9. DRAINING: returns MODE_NOT_ADMITTING with zero reservation reads', async () => {
    const { productId } = ids();
    setMode('DRAINING');
    const getReservedByOthersSpy = jest.spyOn(inventoryReservations, 'getReservedByOthers');
    const getSuspectStatusSpy = jest.spyOn(inventoryReservations, 'getAvailabilityWithSuspectStatus');

    const result = await service.getGeneralAvailability(productId, 10);

    expect(result).toEqual({ ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' });
    expect(getReservedByOthersSpy).not.toHaveBeenCalled();
    expect(getSuspectStatusSpy).not.toHaveBeenCalled();
  });

  it('10. produces no Redis writes across any mode - before/after keyspace snapshot is identical', async () => {
    const { cartId, productId, customerId } = ids();
    await inventoryReservations.reserve(productId, 'cart-other', 4);
    await inventoryReservations.reserveOrRenew('cart-other', productId, customerId, 3);

    const before = await snapshotKeyspace(client);

    for (const mode of ['LEGACY', 'MIRROR', 'CART_SCOPED', 'DRAINING'] as const) {
      setMode(mode);
      await service.getGeneralAvailability(productId, 10);
      await service.getCartAdmissionAvailability(productId, 10, cartId);
    }

    const after = await snapshotKeyspace(client);

    expect(after).toEqual(before);
  });
});
