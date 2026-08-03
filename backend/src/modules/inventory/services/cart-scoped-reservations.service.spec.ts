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

  beforeEach(() => {
    redis = {
      eval: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
    };
    service = new InventoryReservationsService(redis as unknown as RedisService);
  });

  describe('reserveOrRenew', () => {
    it('calls eval with the five reservation keys and the exact argument order', async () => {
      const fakeEntry = {
        version: 1,
        quantity: 4,
        cartId: 'cart-1',
        customerId: 'user-1',
        status: 'ACTIVE',
        createdAt: 1000,
        lastRenewedAt: 1000,
        expiresAt: 1000 + 900_000,
        absoluteExpiresAt: 1000 + 3_600_000,
        checkoutIdempotencyKey: null,
        checkoutPendingAt: null,
        checkoutPendingExpiresAt: null,
      };
      redis.eval.mockResolvedValue(JSON.stringify({ ok: true, entry: fakeEntry, underflow: null }));

      const outcome = await service.reserveOrRenew('cart-1', 'product-1', 'user-1', 4);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe('string');
      expect(keys).toEqual([
        'inv:reserved:{cart-1}:product-1',
        'inv:reserved:cart-index:{cart-1}',
        'inv:reserved:product-index:{product-1}',
        'inv:reserved:product-total:{product-1}',
        'inv:reserved:product-total-suspect:{product-1}',
      ]);
      expect(args[0]).toBe('cart-1');
      expect(args[1]).toBe('product-1');
      expect(args[2]).toBe('user-1');
      expect(args[3]).toBe(4);
      expect(typeof args[4]).toBe('number');
      expect(args[5]).toBe(900_000);
      expect(args[6]).toBe(3_600_000);
      expect(args[7]).toBe(1);

      expect(outcome).toEqual({ ok: true, result: { entry: fakeEntry, underflow: null } });
    });

    it('surfaces RESERVATION_CHECKOUT_IN_PROGRESS from the script unchanged', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ err: 'RESERVATION_CHECKOUT_IN_PROGRESS' }));

      const outcome = await service.reserveOrRenew('cart-1', 'product-1', 'user-1', 4);

      expect(outcome).toEqual({ ok: false, code: 'RESERVATION_CHECKOUT_IN_PROGRESS' });
    });

    it('surfaces RESERVATION_PRODUCT_SUSPENDED from the script unchanged', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ err: 'RESERVATION_PRODUCT_SUSPENDED' }));

      const outcome = await service.reserveOrRenew('cart-1', 'product-1', 'user-1', 6);

      expect(outcome).toEqual({ ok: false, code: 'RESERVATION_PRODUCT_SUSPENDED' });
    });

    it('maps an underflow signal from the script into structured details and logs it', async () => {
      const fakeEntry = { version: 1, quantity: 2 } as never;
      redis.eval.mockResolvedValue(
        JSON.stringify({
          ok: true,
          entry: fakeEntry,
          underflow: { reservationQuantity: 5, storedTotal: 3 },
        }),
      );

      const outcome = await service.reserveOrRenew('cart-1', 'product-1', 'user-1', 2);

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.underflow).toEqual({
          productId: 'product-1',
          cartId: 'cart-1',
          reservationQuantity: 5,
          storedTotal: 3,
          operationName: 'reserveOrRenew',
          timestamp: expect.any(Number) as number,
        });
      }
    });

    it('throws if the script does not return a string result', async () => {
      redis.eval.mockResolvedValue(null);

      await expect(service.reserveOrRenew('cart-1', 'product-1', 'user-1', 1)).rejects.toThrow(
        'Reservation script did not return a JSON string result',
      );
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
      expect(entry?.quantity).toBe(4);
    });

    it('returns null when no reservation exists', async () => {
      redis.get.mockResolvedValue(null);

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toBeNull();
    });

    it('self-heals an expired entry via releaseReservation and returns null', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ expiresAt: Date.now() - 1000 }));
      redis.eval.mockResolvedValue(
        JSON.stringify({ ok: true, released: true, quantity: 4, underflow: null }),
      );

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toBeNull();
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [, , args] = redis.eval.mock.calls[0]!;
      expect(args).toEqual(['cart-1', 'product-1']);
    });

    it('flags malformed JSON as suspect, logs it, and never deletes the key', async () => {
      redis.get.mockResolvedValue('{not valid json');

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toBeNull();
      expect(redis.set).toHaveBeenCalledWith('inv:reserved:product-total-suspect:{product-1}', '1');
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('flags a version mismatch as suspect and never deletes the key', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ version: 2 }));

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toBeNull();
      expect(redis.set).toHaveBeenCalledWith('inv:reserved:product-total-suspect:{product-1}', '1');
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('flags a non-positive quantity as suspect and never deletes the key', async () => {
      redis.get.mockResolvedValue(cartScopedEntryJson({ quantity: 0 }));

      const entry = await service.getActiveReservation('cart-1', 'product-1');

      expect(entry).toBeNull();
      expect(redis.set).toHaveBeenCalledWith('inv:reserved:product-total-suspect:{product-1}', '1');
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });
});
