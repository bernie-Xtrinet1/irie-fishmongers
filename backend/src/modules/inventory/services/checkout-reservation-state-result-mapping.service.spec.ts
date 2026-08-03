import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutReservationPlanItem } from './checkout-reservation-state.types';
import { CheckoutReservationStateService } from './checkout-reservation-state.service';

// checkoutMark result-mapping coverage: scriptVersion protocol, plan-level
// failures, reservation validation failures, success, and retry behavior.
// Input validation, KEYS/ARGV construction, and caller-wiring coverage
// live in checkout-reservation-state.service.spec.ts - split to keep both
// files within the repository's 400-line file limit.
describe('CheckoutReservationStateService (result mapping)', () => {
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

  describe('scriptVersion protocol', () => {
    it('accepts a matching scriptVersion and maps the result normally', async () => {
      redis.eval.mockResolvedValue(successJson());

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: [] });
    });

    it('throws when scriptVersion is missing', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ ok: true, suspectProductIds: [] }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result is missing a numeric scriptVersion');
    });

    it('throws when scriptVersion does not match the supported version', async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ scriptVersion: 2, ok: true, suspectProductIds: [] }),
      );

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script returned unsupported scriptVersion 2');
    });

    it('throws when the script does not return a string result', async () => {
      redis.eval.mockResolvedValue(null);

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script did not return a JSON string result');
    });
  });

  describe('plan-level failures', () => {
    it('maps CHECKOUT_PLAN_EMPTY', async () => {
      redis.eval.mockResolvedValue(successJson({ ok: undefined, err: 'CHECKOUT_PLAN_EMPTY' }));

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: false, code: 'CHECKOUT_PLAN_EMPTY' });
    });

    it('maps CHECKOUT_PLAN_DUPLICATE_PRODUCT with sorted duplicateProductIds', async () => {
      redis.eval.mockResolvedValue(
        successJson({
          ok: undefined,
          err: 'CHECKOUT_PLAN_DUPLICATE_PRODUCT',
          duplicateProductIds: ['product-2', 'product-1'],
        }),
      );

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({
        ok: false,
        code: 'CHECKOUT_PLAN_DUPLICATE_PRODUCT',
        duplicateProductIds: ['product-1', 'product-2'],
      });
    });

    it('maps CHECKOUT_PLAN_MISMATCH with every detail array sorted', async () => {
      redis.eval.mockResolvedValue(
        successJson({
          ok: undefined,
          err: 'CHECKOUT_PLAN_MISMATCH',
          submittedProductIds: ['product-3', 'product-1'],
          indexedProductIds: ['product-2', 'product-1'],
          missingFromPlan: ['product-2'],
          missingFromIndex: ['product-3'],
        }),
      );

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({
        ok: false,
        code: 'CHECKOUT_PLAN_MISMATCH',
        details: {
          submittedProductIds: ['product-1', 'product-3'],
          indexedProductIds: ['product-1', 'product-2'],
          missingFromPlan: ['product-2'],
          missingFromIndex: ['product-3'],
          duplicateProductIds: [],
        },
      });
    });

    it('maps CHECKOUT_PLAN_MISMATCH correctly when every array is empty in the raw result', async () => {
      redis.eval.mockResolvedValue(
        successJson({
          ok: undefined,
          err: 'CHECKOUT_PLAN_MISMATCH',
          submittedProductIds: {},
          indexedProductIds: {},
          missingFromPlan: {},
          missingFromIndex: {},
        }),
      );

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({
        ok: false,
        code: 'CHECKOUT_PLAN_MISMATCH',
        details: {
          submittedProductIds: [],
          indexedProductIds: [],
          missingFromPlan: [],
          missingFromIndex: [],
          duplicateProductIds: [],
        },
      });
    });
  });

  describe('reservation validation failures', () => {
    it.each([
      'RESERVATION_MISSING',
      'RESERVATION_MALFORMED',
      'RESERVATION_VERSION_MISMATCH',
      'RESERVATION_OWNER_MISMATCH',
      'RESERVATION_QUANTITY_MISMATCH',
      'RESERVATION_EXPIRED',
      'RESERVATION_ABSOLUTE_EXPIRED',
      'RESERVATION_CHECKOUT_KEY_CONFLICT',
    ] as const)('maps %s with the failed product id', async (code) => {
      redis.eval.mockResolvedValue(
        successJson({ ok: undefined, err: code, failedProductId: 'product-1' }),
      );

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: false, code, failedProductId: 'product-1' });
    });
  });

  describe('success', () => {
    it('returns sorted suspectProductIds', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: ['product-2', 'product-1'] }));

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: ['product-1', 'product-2'] });
    });

    it('maps a same-key replay success identically to a first mark', async () => {
      redis.eval.mockResolvedValue(successJson());

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: [] });
    });
  });

  describe('array field validation (toStringArray hardening)', () => {
    it('accepts an empty array and returns []', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: [] }));

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: [] });
    });

    it('accepts an empty object (the cjson empty-table encoding) and returns []', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: {} }));

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: [] });
    });

    it('accepts a string array and sorts it', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: ['product-2', 'product-1'] }));

      const result = await service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180);

      expect(result).toEqual({ ok: true, suspectProductIds: ['product-1', 'product-2'] });
    });

    it('throws when the array contains a non-string value', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: ['product-1', 42] }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow(
        'Checkout script result field "suspectProductIds" is an array containing non-string values',
      );
    });

    it('throws when the field is a non-empty object', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: { foo: 'bar' } }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result field "suspectProductIds" has an unexpected shape');
    });

    it('throws when the field is a string', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: 'not-an-array' }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result field "suspectProductIds" has an unexpected shape');
    });

    it('throws when the field is null', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: null }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result field "suspectProductIds" has an unexpected shape');
    });

    it('throws when the field is a number', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: 7 }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result field "suspectProductIds" has an unexpected shape');
    });

    it('throws when the field is a boolean', async () => {
      redis.eval.mockResolvedValue(successJson({ suspectProductIds: true }));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('Checkout script result field "suspectProductIds" has an unexpected shape');
    });
  });

  describe('no internal retry loop', () => {
    it('calls eval exactly once even when it rejects', async () => {
      redis.eval.mockRejectedValue(new Error('boom'));

      await expect(
        service.checkoutMark(cartId, customerId, checkoutKey, onePlan(), now, 180),
      ).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });
  });
});
