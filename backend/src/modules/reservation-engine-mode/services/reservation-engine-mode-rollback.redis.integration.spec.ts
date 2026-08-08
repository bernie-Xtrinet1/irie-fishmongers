import { Redis } from 'ioredis';

import {
  cartIndexKey,
  productTotalKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { connectRealRedis, ids } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import { ReservationEngineModeConfigRepository } from '../repositories/reservation-engine-mode-config.repository';
import { ReservationEngineModeService } from './reservation-engine-mode.service';

// Real-Redis integration coverage for ReservationEngineModeService's
// rollback-verification gate (see ADR-007 Decision 8). The unit suite
// (reservation-engine-mode.service.spec.ts) mocks the Redis client and can
// only verify the scan/parse calling contract; it cannot prove the gate
// correctly observes genuine reserveOrRenew state or genuinely-drifted
// structures. This suite requires a reachable Redis (REDIS_URL) and fails
// loudly rather than skipping - same convention as every other real-Redis
// spec in this codebase.
//
// ReservationEngineModeConfigRepository (Postgres) is mocked here - its
// own real-Postgres behavior is covered by
// reservation-engine-mode-config.repository.spec.ts, and the
// append-only-concurrency advisory lock is covered by
// reservation-engine-mode-concurrency.service.spec.ts; this file exists
// to prove the Redis-facing half of the gate against genuine and
// deliberately-drifted structures.
//
// Test isolation - dedicated logical Redis DB, not the shared ambient
// one: verifyRollbackSafe() is deliberately a whole-keyspace scan by
// design (rollback safety must consider the entire catalog, not one
// product - see ADR-007 Decision 8), and setMode's ROLLBACK_STRUCTURE_
// DRIFT-over-ROLLBACK_BLOCKED priority means even one unrelated drifted
// key anywhere makes every setMode call report drift. The default
// logical DB (0, what REDIS_URL/connectRealRedis() connects to) is a
// long-lived shared dev/test instance known to carry leftover
// inv:reserved:* keys from unrelated prior test runs across this
// codebase's history (a pre-existing test-hygiene gap, tracked
// separately, never touched by this suite). Rather than depend on that
// ambient state, or risk this suite's own writes polluting it further,
// every test here runs against logical DB 1 (SELECT 1), FLUSHDB'd before
// each test and once more after the whole suite - an isolated keyspace
// this suite exclusively owns, verified unused by any other spec in this
// codebase before adopting it. This never touches DB 0's real content.
//
// verifyRollbackSafe() does a full SCAN across every product-total and
// cart-index key, plus a getActiveReservation round trip per index
// member - correctness-appropriate for a rare, manually-triggered
// emergency-rollback gate. jest.setTimeout below is raised to the same
// order of magnitude already established for e2e specs as a margin, even
// though DB 1 being empty-by-construction keeps this suite's own scans
// fast.
jest.setTimeout(30_000);

const ISOLATED_DB_INDEX = 1;

describe('ReservationEngineModeService (real Redis integration - rollback gate)', () => {
  let client: Redis;
  let inventoryReservations: InventoryReservationsService;
  let repository: jest.Mocked<Pick<ReservationEngineModeConfigRepository, 'findCurrent' | 'create'>>;
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction'>>;
  let service: ReservationEngineModeService;

  beforeAll(async () => {
    client = await connectRealRedis();
    await client.select(ISOLATED_DB_INDEX);
    inventoryReservations = new InventoryReservationsService(new RedisService(client));
  });

  afterAll(async () => {
    await client.flushdb();
    await client.quit();
  });

  beforeEach(async () => {
    await client.flushdb();
    repository = { findCurrent: jest.fn(), create: jest.fn() };
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        Promise.resolve(fn({ $executeRaw: jest.fn().mockResolvedValue(0) })),
      ),
    } as never;
    service = new ReservationEngineModeService(
      prisma as unknown as PrismaService,
      repository as unknown as ReservationEngineModeConfigRepository,
      new RedisService(client),
      inventoryReservations,
    );
  });

  function draining() {
    repository.findCurrent.mockResolvedValue({
      id: 'config-1',
      mode: 'DRAINING',
      updatedById: 'admin-1',
      createdAt: new Date(),
    });
  }

  // Case 1: product totals = 0, cart indexes = 0 -> rollback may proceed.
  it('case 1: reports clear and allows setMode end-to-end against a genuinely empty keyspace', async () => {
    draining();
    repository.create.mockResolvedValue({
      id: 'config-2',
      mode: 'LEGACY',
      updatedById: 'admin-1',
      createdAt: new Date(),
    });

    const verification = await service.verifyRollbackSafe();
    expect(verification).toEqual({ clear: true, outstandingProductIds: [], structureDriftProductIds: [] });

    const result = await service.setMode({ targetMode: 'LEGACY', updatedById: 'admin-1' });
    expect(result).toEqual({ ok: true, id: 'config-2', mode: 'LEGACY', createdAt: expect.any(Date) as Date });
  });

  // Case 4: product total > 0, cart index has a genuinely live member ->
  // rollback rejected as ROLLBACK_BLOCKED (both signals agree, no drift).
  it('case 4: rejects with ROLLBACK_BLOCKED when both signals agree the product is held', async () => {
    const { cartId, productId, customerId } = ids();
    draining();

    const reserveOutcome = await inventoryReservations.reserveOrRenew(cartId, productId, customerId, 2);
    expect(reserveOutcome.ok).toBe(true);

    const verification = await service.verifyRollbackSafe();
    expect(verification).toEqual({
      clear: false,
      outstandingProductIds: [productId],
      structureDriftProductIds: [],
    });

    const result = await service.setMode({ targetMode: 'LEGACY', updatedById: 'admin-1' });
    expect(result).toEqual({ ok: false, code: 'ROLLBACK_BLOCKED', outstandingProductIds: [productId] });
    expect(repository.create).not.toHaveBeenCalled();

    await inventoryReservations.releaseReservation(cartId, productId);
    const clearedVerification = await service.verifyRollbackSafe();
    expect(clearedVerification).toEqual({ clear: true, outstandingProductIds: [], structureDriftProductIds: [] });
  });

  // Case 2: product total > 0, cart index empty -> rejected as
  // ROLLBACK_STRUCTURE_DRIFT, not ROLLBACK_BLOCKED. Deliberately
  // manufactured (direct SET on the product-total key, bypassing
  // reserveOrRenew entirely) - under normal atomic operation the Lua
  // scripts never let the two structures disagree, so this scenario can
  // only be produced by simulating exactly the kind of corruption the
  // drift check exists to catch.
  it('case 2: rejects with ROLLBACK_STRUCTURE_DRIFT when the total is non-zero but the index is empty', async () => {
    const { productId } = ids();
    draining();

    await client.set(productTotalKey(productId), '4');

    const verification = await service.verifyRollbackSafe();
    expect(verification).toEqual({
      clear: false,
      outstandingProductIds: [],
      structureDriftProductIds: [productId],
    });

    const result = await service.setMode({ targetMode: 'LEGACY', updatedById: 'admin-1' });
    expect(result).toEqual({
      ok: false,
      code: 'ROLLBACK_STRUCTURE_DRIFT',
      structureDriftProductIds: [productId],
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  // Case 3: product totals = 0, cart index has a live member -> rejected
  // as ROLLBACK_STRUCTURE_DRIFT. Deliberately manufactured (a raw
  // reservation entry + cart-index membership written directly, bypassing
  // reserveOrRenew so the product-total key is never touched) - the same
  // kind of corruption as case 2, in the opposite direction.
  it('case 3: rejects with ROLLBACK_STRUCTURE_DRIFT when the index shows a live hold but the total is zero', async () => {
    const { cartId, productId, customerId } = ids();
    draining();

    const now = Date.now();
    const entry = {
      version: 1,
      quantity: 1,
      cartId,
      customerId,
      status: 'ACTIVE',
      createdAt: now,
      lastRenewedAt: now,
      expiresAt: now + 900_000,
      absoluteExpiresAt: now + 3_600_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
    };
    await client.set(reservationKey(cartId, productId), JSON.stringify(entry));
    await client.sadd(cartIndexKey(cartId), productId);

    const verification = await service.verifyRollbackSafe();
    expect(verification).toEqual({
      clear: false,
      outstandingProductIds: [],
      structureDriftProductIds: [productId],
    });

    const result = await service.setMode({ targetMode: 'LEGACY', updatedById: 'admin-1' });
    expect(result).toEqual({
      ok: false,
      code: 'ROLLBACK_STRUCTURE_DRIFT',
      structureDriftProductIds: [productId],
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  // Case 6: CART_SCOPED -> LEGACY directly (no intermediate DRAINING
  // pause) is rejected by the state machine itself - proven at the unit
  // level (mocked Redis, no real infra needed to exercise this branch);
  // re-confirmed here against the real service wiring for completeness.
  it('case 6: rejects CART_SCOPED -> LEGACY directly, without going through DRAINING', async () => {
    repository.findCurrent.mockResolvedValue({
      id: 'config-1',
      mode: 'CART_SCOPED',
      updatedById: 'admin-1',
      createdAt: new Date(),
    });

    const result = await service.setMode({ targetMode: 'LEGACY', updatedById: 'admin-1' });

    expect(result).toEqual({ ok: false, code: 'INVALID_TRANSITION', from: 'CART_SCOPED', to: 'LEGACY' });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
