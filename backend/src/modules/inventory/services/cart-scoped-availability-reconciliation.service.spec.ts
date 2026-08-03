import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from './inventory-reservations.service';

// Cart-scoped reservation model (additive; not wired to any caller) -
// aggregate/reporting operations only. Mutation and single-entry-read
// operations (reserveOrRenew, releaseReservation, getActiveReservation)
// live in cart-scoped-reservations.service.spec.ts; this file was split
// out purely to keep both files within the repository's 400-line file
// limit, with no change to any assertion or behavior.

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

describe('InventoryReservationsService (cart-scoped model - availability/reconciliation)', () => {
  let redis: jest.Mocked<Pick<RedisService, 'eval' | 'get'>>;
  let service: InventoryReservationsService;

  beforeEach(() => {
    redis = {
      eval: jest.fn(),
      get: jest.fn(),
    };
    service = new InventoryReservationsService(redis as unknown as RedisService);
  });

  describe('getReservedTotalExcludingCart', () => {
    it('subtracts the requesting cart’s own active quantity from the stored total', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('10');
        if (key === 'inv:reserved:{cart-1}:product-1') {
          return Promise.resolve(cartScopedEntryJson({ quantity: 3 }));
        }
        return Promise.resolve(null);
      });

      const result = await service.getReservedTotalExcludingCart('product-1', 'cart-1');

      expect(result).toBe(7);
    });

    it('treats a missing stored total as zero', async () => {
      redis.get.mockResolvedValue(null);

      const result = await service.getReservedTotalExcludingCart('product-1', 'cart-1');

      expect(result).toBe(0);
    });

    it('treats an empty excludingCartId as "exclude nothing" without querying a reservation key', async () => {
      redis.get.mockResolvedValue('10');

      const result = await service.getReservedTotalExcludingCart('product-1', '');

      expect(result).toBe(10);
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(redis.get).toHaveBeenCalledWith('inv:reserved:product-total:{product-1}');
    });

    it('never returns a negative number', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('2');
        if (key === 'inv:reserved:{cart-1}:product-1') {
          return Promise.resolve(cartScopedEntryJson({ quantity: 5 }));
        }
        return Promise.resolve(null);
      });

      const result = await service.getReservedTotalExcludingCart('product-1', 'cart-1');

      expect(result).toBe(0);
    });
  });

  describe('computeAvailableToPurchase', () => {
    it('subtracts reservations held by other carts from quantityAvailable', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve(null);
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('3');
        return Promise.resolve(null);
      });

      const available = await service.computeAvailableToPurchase('product-1', 10, '');

      expect(available).toBe(7);
    });

    it('returns zero unconditionally while the product is suspect, regardless of the stored total', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve('1');
        return Promise.resolve(null);
      });

      const available = await service.computeAvailableToPurchase('product-1', 100, '');

      expect(available).toBe(0);
    });
  });

  describe('reconcileProductReservedTotal', () => {
    function reconciliationJson(overrides: Partial<Record<string, unknown>> = {}): string {
      return JSON.stringify({
        productId: 'product-1',
        membersChecked: 3,
        activeReservations: 2,
        staleMembersRemoved: 1,
        malformedEntries: 0,
        versionMismatches: 0,
        storedTotal: 5,
        calculatedTotal: 5,
        difference: 0,
        driftDirection: 'NO_DRIFT',
        repairedValue: 5,
        admissionSuspended: false,
        ...overrides,
      });
    }

    it('calls eval with the three product-level keys and the exact argument order', async () => {
      redis.eval.mockResolvedValue(reconciliationJson());

      await service.reconcileProductReservedTotal('product-1');

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe('string');
      expect(keys).toEqual([
        'inv:reserved:product-index:{product-1}',
        'inv:reserved:product-total:{product-1}',
        'inv:reserved:product-total-suspect:{product-1}',
      ]);
      expect(args[0]).toBe('product-1');
      expect(typeof args[1]).toBe('number');
      expect(args[2]).toBe(1);
    });

    it('returns a NO_DRIFT result unchanged', async () => {
      redis.eval.mockResolvedValue(reconciliationJson());

      const result = await service.reconcileProductReservedTotal('product-1');

      expect(result.driftDirection).toBe('NO_DRIFT');
      expect(result.admissionSuspended).toBe(false);
    });

    it('returns an OVERCOUNT result with admission not suspended', async () => {
      redis.eval.mockResolvedValue(
        reconciliationJson({
          storedTotal: 9,
          calculatedTotal: 5,
          difference: -4,
          driftDirection: 'OVERCOUNT',
          repairedValue: 5,
          admissionSuspended: false,
        }),
      );

      const result = await service.reconcileProductReservedTotal('product-1');

      expect(result.driftDirection).toBe('OVERCOUNT');
      expect(result.repairedValue).toBe(5);
      expect(result.admissionSuspended).toBe(false);
    });

    it('returns an UNDERCOUNT result with the repaired value and admission cleared after verification', async () => {
      redis.eval.mockResolvedValue(
        reconciliationJson({
          storedTotal: 2,
          calculatedTotal: 8,
          difference: 6,
          driftDirection: 'UNDERCOUNT',
          repairedValue: 8,
          admissionSuspended: false,
        }),
      );

      const result = await service.reconcileProductReservedTotal('product-1');

      expect(result.driftDirection).toBe('UNDERCOUNT');
      expect(result.repairedValue).toBe(8);
      expect(result.admissionSuspended).toBe(false);
    });

    it('reports admissionSuspended true when the script could not verify the repair', async () => {
      redis.eval.mockResolvedValue(
        reconciliationJson({
          driftDirection: 'UNDERCOUNT',
          admissionSuspended: true,
        }),
      );

      const result = await service.reconcileProductReservedTotal('product-1');

      expect(result.admissionSuspended).toBe(true);
    });

    it('reports malformed entries and version mismatches separately from stale members', async () => {
      redis.eval.mockResolvedValue(
        reconciliationJson({
          membersChecked: 4,
          activeReservations: 1,
          staleMembersRemoved: 1,
          malformedEntries: 1,
          versionMismatches: 1,
        }),
      );

      const result = await service.reconcileProductReservedTotal('product-1');

      expect(result.malformedEntries).toBe(1);
      expect(result.versionMismatches).toBe(1);
      expect(result.staleMembersRemoved).toBe(1);
    });
  });
});
