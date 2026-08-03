import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutReservationPlanItem } from './checkout-reservation-state.types';
import { CheckoutReservationStateService } from './checkout-reservation-state.service';

// checkoutMark input validation, KEYS/ARGV construction, and caller-wiring
// coverage. Result-mapping coverage (scriptVersion protocol, plan-level
// failures, reservation validation failures, success, retry behavior) is
// split into checkout-reservation-state-result-mapping.service.spec.ts to
// keep both files within the repository's 400-line file limit.
describe('CheckoutReservationStateService', () => {
  let redis: jest.Mocked<Pick<RedisService, 'eval'>>;
  let service: CheckoutReservationStateService;

  const cartId = 'cart-1';
  const customerId = 'user-1';
  const checkoutKey = 'checkout-key-1';
  const now = 1_000_000;

  beforeEach(() => {
    redis = { eval: jest.fn() };
    service = new CheckoutReservationStateService(redis as unknown as RedisService);
  });

  function successJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ scriptVersion: 1, ok: true, suspectProductIds: [], ...overrides });
  }

  function onePlan(): CheckoutReservationPlanItem[] {
    return [{ productId: 'product-1', expectedQuantity: 2 }];
  }

  describe('input validation', () => {
    it('rejects an empty cartId without calling eval', async () => {
      const result = await service.checkoutMark('', customerId, checkoutKey, onePlan(), now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-containing cartId without calling eval', async () => {
      const result = await service.checkoutMark('cart 1', customerId, checkoutKey, onePlan(), now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects an empty customerId without calling eval', async () => {
      const result = await service.checkoutMark(cartId, '', checkoutKey, onePlan(), now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'customerId',
        reason: 'customerId cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects an empty checkoutIdempotencyKey without calling eval', async () => {
      const result = await service.checkoutMark(cartId, customerId, '', onePlan(), now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-containing checkoutIdempotencyKey without calling eval', async () => {
      const result = await service.checkoutMark(cartId, customerId, 'key 1', onePlan(), now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'checkoutIdempotencyKey',
        reason: 'checkoutIdempotencyKey cannot contain whitespace',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects an empty item list without calling eval', async () => {
      const result = await service.checkoutMark(cartId, customerId, checkoutKey, [], now, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'items',
        reason: 'items cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects an invalid productId without calling eval', async () => {
      const result = await service.checkoutMark(
        cartId,
        customerId,
        checkoutKey,
        [{ productId: '', expectedQuantity: 1 }],
        now,
        180,
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'productId',
        reason: 'productId cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-positive expectedQuantity without calling eval', async () => {
      const result = await service.checkoutMark(
        cartId,
        customerId,
        checkoutKey,
        [{ productId: 'product-1', expectedQuantity: 0 }],
        now,
        180,
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'expectedQuantity',
        reason: 'expectedQuantity must be a positive integer',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-integer expectedQuantity without calling eval', async () => {
      const result = await service.checkoutMark(
        cartId,
        customerId,
        checkoutKey,
        [{ productId: 'product-1', expectedQuantity: 1.5 }],
        now,
        180,
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'expectedQuantity',
        reason: 'expectedQuantity must be a positive integer',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-finite now without calling eval', async () => {
      const result = await service.checkoutMark(
        cartId,
        customerId,
        checkoutKey,
        onePlan(),
        Number.NaN,
        180,
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now must be a finite, non-negative number',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a negative now without calling eval', async () => {
      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), -1, 180);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'now',
        reason: 'now must be a finite, non-negative number',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-positive initialLeaseSeconds without calling eval', async () => {
      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 0);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'initialLeaseSeconds',
        reason: 'initialLeaseSeconds must be a positive integer',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('KEYS/ARGV construction', () => {
    it('builds the exact keys and args for a single-item plan', async () => {
      redis.eval.mockResolvedValue(successJson());

      await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe('string');
      expect(keys).toEqual([
        'inv:reserved:cart-index:{cart-1}',
        'inv:reserved:{cart-1}:product-1',
        'inv:reserved:product-total-suspect:{product-1}',
      ]);
      expect(args).toEqual([
        cartId,
        customerId,
        checkoutKey,
        now,
        180_000,
        600_000,
        1,
        'product-1',
        2,
      ]);
    });

    it('builds the exact keys and args for a multi-item plan, preserving plan order', async () => {
      redis.eval.mockResolvedValue(successJson());
      const items: CheckoutReservationPlanItem[] = [
        { productId: 'product-1', expectedQuantity: 2 },
        { productId: 'product-2', expectedQuantity: 5 },
      ];

      await service.checkoutMark(cartId, customerId, checkoutKey, items, now, 180);

      const [, keys, args] = redis.eval.mock.calls[0]!;
      expect(keys).toEqual([
        'inv:reserved:cart-index:{cart-1}',
        'inv:reserved:{cart-1}:product-1',
        'inv:reserved:{cart-1}:product-2',
        'inv:reserved:product-total-suspect:{product-1}',
        'inv:reserved:product-total-suspect:{product-2}',
      ]);
      expect(args).toEqual([
        cartId,
        customerId,
        checkoutKey,
        now,
        180_000,
        600_000,
        2,
        'product-1',
        'product-2',
        2,
        5,
      ]);
    });
  });

  describe('no caller wiring', () => {
    it('is never referenced by CartService, OrdersService, or ProductsService', () => {
      const fs = jest.requireActual<typeof import('fs')>('fs');
      const path = jest.requireActual<typeof import('path')>('path');
      const roots = ['../../cart', '../../orders', '../../products'].map((rel) =>
        path.resolve(__dirname, rel),
      );

      function collectTsFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap((entry: import('fs').Dirent) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return collectTsFiles(full);
          return entry.name.endsWith('.ts') ? [full] : [];
        });
      }

      const offenders: string[] = [];
      for (const root of roots) {
        for (const file of collectTsFiles(root)) {
          const contents = fs.readFileSync(file, 'utf8');
          if (contents.includes('CheckoutReservationStateService')) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
