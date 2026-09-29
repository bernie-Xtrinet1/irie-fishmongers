import { OrdinaryReservationService } from './ordinary-reservation.service';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from './inventory-reservations.service';

// Cart-scoped reservation model (additive; not wired to any caller) -
// mutation and single-entry-read operations only (reserveOrRenew,
// releaseReservation, getActiveReservation). Aggregate/reporting operations
// (getReservedTotalExcludingCart, computeAvailableToPurchase,
// reconcileProductReservedTotal) live in
// cart-scoped-availability-reconciliation.service.spec.ts - split purely to
// keep both files within the repository's 400-line file limit, with no
// change to any assertion or behavior. These tests validate the
// TypeScript-to-Lua calling contract (exact keys/args passed, exact result
// mapping) since redis.eval is mocked here rather than executed against a
// real Redis - the Lua scripts' own internal arithmetic is exercised by
// inventory-reservations.redis.integration.spec.ts and
// inventory-reservations-reconciliation.redis.integration.spec.ts instead.
// Legacy per-product-hash model tests live in
// inventory-reservations.service.spec.ts.

describe('InventoryReservationsService (cart-scoped model)', () => {
  let redis: jest.Mocked<Pick<RedisService, 'eval' | 'get' | 'set'>>;
  let service: InventoryReservationsService;
  const ordinary = { reserve: jest.fn() };

  beforeEach(async () => {
    redis = {
      eval: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
    };
    ordinary.reserve.mockReset();
    const testingModule = await Test.createTestingModule({ providers: [InventoryReservationsService,
      { provide: RedisService, useValue: redis }, { provide: OrdinaryReservationService, useValue: ordinary },
      { provide: PrismaService, useValue: {
        reservationFenceTransition: { findFirst: jest.fn() },
        productReservationRestriction: { findUnique: jest.fn() },
        productReservationRestrictionInstallation: { findUnique: jest.fn() },
      } }] }).compile();
    service = testingModule.get(InventoryReservationsService);
  });

  describe('reserveOrRenew', () => {
    it('delegates exact caller scope to the required durable W1 boundary, never raw Lua', async () => {
      const entry = { version: 1, status: 'ACTIVE', quantity: 4 };
      ordinary.reserve.mockResolvedValue({ code: 'ACCEPTED', value: entry });
      expect(await service.reserveOrRenew('cart-1', 'product-1', 'user-1', 4))
        .toEqual({ ok: true, result: { entry, underflow: null } });
      expect(ordinary.reserve).toHaveBeenCalledWith('cart-1', 'product-1', 'user-1', 4);
      expect(redis.eval).not.toHaveBeenCalled();
    });
    it('preserves product suspension as a domain failure', async () => {
      ordinary.reserve.mockResolvedValue({ code: 'DOMAIN_FAILURE', reason: 'RESERVATION_PRODUCT_SUSPENDED' });
      expect(await service.reserveOrRenew('cart', 'product', 'customer', 4)).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
    });
    it('preserves fencing rejection without retry or a raw fallback', async () => {
      ordinary.reserve.mockResolvedValue({ code: 'FENCE_REJECTED', reason: 'PHASE_DENIED' });
      expect(await service.reserveOrRenew('cart', 'product', 'customer', 4)).toEqual({ ok: false, code: 'FENCE_REJECTED' });
      expect(ordinary.reserve).toHaveBeenCalledTimes(1); expect(redis.eval).not.toHaveBeenCalled();
    });
    it('preserves uncertain infrastructure instead of assuming a failed physical write', async () => {
      ordinary.reserve.mockResolvedValue({ code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' });
      expect(await service.reserveOrRenew('cart', 'product', 'customer', 4)).toEqual({ ok: false, code: 'UNCERTAIN_INFRASTRUCTURE' });
    });
    it('does not expose an unfenced administrative lifetime-reset path', async () => {
      expect(await service.reserveWithFreshEpoch('cart', 'product', 'customer', 4)).toEqual({ ok: false, code: 'FENCE_REJECTED' });
      expect(ordinary.reserve).not.toHaveBeenCalled(); expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('releaseReservation', () => {
    it('calls eval with the five reservation keys and cartId/productId args', async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ ok: true, released: true, quantity: 3, underflow: null }),
      );

      const result = await service.releaseReservation('cart-1', 'product-1');

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [, keys, args] = redis.eval.mock.calls[0]!;
      expect(keys).toEqual([
        'inv:reserved:{cart-1}:product-1',
        'inv:reserved:cart-index:{cart-1}',
        'inv:reserved:product-index:{product-1}',
        'inv:reserved:product-total:{product-1}',
        'inv:reserved:product-total-suspect:{product-1}',
      ]);
      expect(args).toEqual(['cart-1', 'product-1']);
      expect(result).toEqual({ released: true, quantity: 3, underflow: null });
    });

    it('is idempotent when the reservation no longer exists', async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ ok: true, released: false, quantity: 0, underflow: null }),
      );

      const result = await service.releaseReservation('cart-1', 'product-1');

      expect(result).toEqual({ released: false, quantity: 0, underflow: null });
    });

    it('maps an underflow signal from the script into structured details and logs it', async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({
          ok: true,
          released: true,
          quantity: 5,
          underflow: { reservationQuantity: 5, storedTotal: 2 },
        }),
      );

      const result = await service.releaseReservation('cart-1', 'product-1');

      expect(result.underflow).toEqual({
        productId: 'product-1',
        cartId: 'cart-1',
        reservationQuantity: 5,
        storedTotal: 2,
        operationName: 'releaseReservation',
        timestamp: expect.any(Number) as number,
      });
    });
  });

  function cartScopedEntryJson(overrides: Partial<Record<string, unknown>> = {}): string {
    return JSON.stringify({
      version: 1,
      quantity: 4,
      cartId: 'cart-1',
      customerId: 'user-1',
      status: 'ACTIVE',
      createdAt: 1000,
      lastRenewedAt: 1000,
      expiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 3_600_000,
      checkoutIdempotencyKey: null,
      checkoutPendingAt: null,
      checkoutPendingExpiresAt: null,
      ...overrides,
    });
  }

  describe('getActiveReservation', () => {
    it('returns the parsed entry when active', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson());

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(redis.get).toHaveBeenCalledWith('inv:reserved:{cart-1}:product-1');
      expect(entry).toMatchObject({ status: 'ACTIVE', entry: { quantity: 4 } });
    });

    it('reports absence when no reservation exists', async () => {
      redis.get.mockResolvedValue(null);

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toEqual({ status: 'ABSENT' });
    });

    it('observes expiry without releasing or repairing', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ expiresAt: Date.now() - 1000 }));
      redis.eval.mockResolvedValue(
        JSON.stringify({ ok: true, released: true, quantity: 4, underflow: null }),
      );

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toEqual({ status: 'EXPIRED' });
      expect(redis.eval).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('reports malformed JSON without mutation', async () => {
      redis.get.mockResolvedValue('{not valid json');

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toEqual({ status: 'MALFORMED' });
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('reports an untrusted version without mutation', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ version: 2 }));

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toEqual({ status: 'UNTRUSTED' });
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('reports malformed quantity without mutation', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ quantity: 0 }));

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toEqual({ status: 'MALFORMED' });
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });
});
