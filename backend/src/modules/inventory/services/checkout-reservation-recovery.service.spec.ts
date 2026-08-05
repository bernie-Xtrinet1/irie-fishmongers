import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutReservationRecoveryService } from './checkout-reservation-recovery.service';

// CheckoutReservationRecoveryService coverage: input validation, KEYS/ARGV
// construction, scriptVersion protocol, every result-bucket mapping,
// underflow array mapping/hardening, admissionSuspended mapping, and
// no-caller-wiring. Real-Redis scenarios (actual Lua classification/
// mutation/idempotency behavior) live in checkout-revert.redis.integration.spec.ts,
// checkout-revert-corruption.redis.integration.spec.ts, and
// checkout-finalize.redis.integration.spec.ts.
describe('CheckoutReservationRecoveryService', () => {
  let redis: jest.Mocked<Pick<RedisService, 'eval'>>;
  let service: CheckoutReservationRecoveryService;

  const cartId = 'cart-1';
  const checkoutKey = 'checkout-key-1';
  const now = 1_000_000;

  beforeEach(() => {
    redis = { eval: jest.fn() };
    service = new CheckoutReservationRecoveryService(redis as unknown as RedisService);
  });

  function revertJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      scriptVersion: 1,
      ok: true,
      restoredProductIds: [],
      deletedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
      ...overrides,
    });
  }

  function finalizeJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      scriptVersion: 1,
      ok: true,
      finalizedProductIds: [],
      skippedProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      underflow: [],
      admissionSuspended: false,
      ...overrides,
    });
  }

  describe('checkoutRevert input validation', () => {
    it.each([
      ['', checkoutKey, now, 'cartId', 'cartId cannot be empty'],
      ['cart 1', checkoutKey, now, 'cartId', 'cartId cannot contain whitespace'],
      [cartId, '', now, 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot be empty'],
      [cartId, 'key 1', now, 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot contain whitespace'],
      [cartId, checkoutKey, Number.NaN, 'now', 'now must be a finite, non-negative number'],
      [cartId, checkoutKey, -1, 'now', 'now must be a finite, non-negative number'],
    ] as const)(
      'rejects invalid input (%s, %s, %s) without calling eval',
      async (givenCartId, givenKey, givenNow, field, reason) => {
        const result = await service.checkoutRevert(givenCartId, givenKey, givenNow);
        expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field, reason });
        expect(redis.eval).not.toHaveBeenCalled();
      },
    );
  });

  describe('finalizeCheckoutConsumption input validation', () => {
    it.each([
      ['', checkoutKey, 'cartId', 'cartId cannot be empty'],
      ['cart 1', checkoutKey, 'cartId', 'cartId cannot contain whitespace'],
      [cartId, '', 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot be empty'],
      [cartId, 'key 1', 'checkoutIdempotencyKey', 'checkoutIdempotencyKey cannot contain whitespace'],
    ] as const)(
      'rejects invalid input (%s, %s) without calling eval',
      async (givenCartId, givenKey, field, reason) => {
        const result = await service.finalizeCheckoutConsumption(givenCartId, givenKey);
        expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field, reason });
        expect(redis.eval).not.toHaveBeenCalled();
      },
    );
  });

  describe('KEYS/ARGV construction', () => {
    it('builds the exact keys and args for checkoutRevert', async () => {
      redis.eval.mockResolvedValue(revertJson());
      await service.checkoutRevert(cartId, checkoutKey, now);
      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe('string');
      expect(keys).toEqual(['inv:reserved:cart-index:{cart-1}']);
      expect(args).toEqual([cartId, checkoutKey, now]);
    });

    it('builds the exact keys and args for finalizeCheckoutConsumption', async () => {
      redis.eval.mockResolvedValue(finalizeJson());
      await service.finalizeCheckoutConsumption(cartId, checkoutKey);
      const [, keys, args] = redis.eval.mock.calls[0]!;
      expect(keys).toEqual(['inv:reserved:cart-index:{cart-1}']);
      expect(args).toEqual([cartId, checkoutKey]);
    });
  });

  describe('scriptVersion protocol', () => {
    it('accepts a matching scriptVersion on checkoutRevert', async () => {
      redis.eval.mockResolvedValue(revertJson());
      const result = await service.checkoutRevert(cartId, checkoutKey, now);
      expect(result.ok).toBe(true);
    });

    it('throws when checkoutRevert scriptVersion is missing', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ ok: true }));
      await expect(service.checkoutRevert(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script result is missing a numeric scriptVersion',
      );
    });

    it('throws when checkoutRevert scriptVersion is unsupported', async () => {
      redis.eval.mockResolvedValue(revertJson({ scriptVersion: 2 }));
      await expect(service.checkoutRevert(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script returned unsupported scriptVersion 2',
      );
    });

    it('throws when checkoutRevert does not return a string result', async () => {
      redis.eval.mockResolvedValue(null);
      await expect(service.checkoutRevert(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script did not return a JSON string result',
      );
    });

    it('accepts a matching scriptVersion on finalizeCheckoutConsumption', async () => {
      redis.eval.mockResolvedValue(finalizeJson());
      const result = await service.finalizeCheckoutConsumption(cartId, checkoutKey);
      expect(result.ok).toBe(true);
    });

    it('throws when finalizeCheckoutConsumption scriptVersion is unsupported', async () => {
      redis.eval.mockResolvedValue(finalizeJson({ scriptVersion: 3 }));
      await expect(service.finalizeCheckoutConsumption(cartId, checkoutKey)).rejects.toThrow(
        'Checkout script returned unsupported scriptVersion 3',
      );
    });
  });

  describe('checkoutRevert result mapping', () => {
    it('maps a full result with every array populated and sorted', async () => {
      redis.eval.mockResolvedValue(
        revertJson({
          restoredProductIds: ['product-2', 'product-1'],
          deletedProductIds: ['product-4', 'product-3'],
          skippedProductIds: ['product-6', 'product-5'],
          malformedProductIds: ['product-8', 'product-7'],
          versionMismatchedProductIds: ['product-j', 'product-i'],
        }),
      );

      const result = await service.checkoutRevert(cartId, checkoutKey, now);

      expect(result).toEqual({
        ok: true,
        restoredProductIds: ['product-1', 'product-2'],
        deletedProductIds: ['product-3', 'product-4'],
        skippedProductIds: ['product-5', 'product-6'],
        malformedProductIds: ['product-7', 'product-8'],
        versionMismatchedProductIds: ['product-i', 'product-j'],
        underflow: [],
        admissionSuspended: false,
      });
    });

    it('maps underflow entries, sorted by productId, with cartId/operationName/timestamp attached', async () => {
      redis.eval.mockResolvedValue(
        revertJson({
          deletedProductIds: ['product-b', 'product-a'],
          underflow: [
            { productId: 'product-b', reservationQuantity: 5, storedTotal: 2 },
            { productId: 'product-a', reservationQuantity: 3, storedTotal: 1 },
          ],
          admissionSuspended: true,
        }),
      );

      const result = await service.checkoutRevert(cartId, checkoutKey, now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.underflow).toEqual([
          {
            productId: 'product-a',
            cartId,
            reservationQuantity: 3,
            storedTotal: 1,
            operationName: 'checkoutRevert',
            timestamp: now,
          },
          {
            productId: 'product-b',
            cartId,
            reservationQuantity: 5,
            storedTotal: 2,
            operationName: 'checkoutRevert',
            timestamp: now,
          },
        ]);
        expect(result.admissionSuspended).toBe(true);
      }
    });

    it('normalizes an empty-object underflow (cjson empty-table quirk) to []', async () => {
      redis.eval.mockResolvedValue(revertJson({ underflow: {} }));
      const result = await service.checkoutRevert(cartId, checkoutKey, now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.underflow).toEqual([]);
      }
    });

    it.each([
      [
        'restoredProductIds',
        { restoredProductIds: 'not-an-array' },
        'Checkout script result field "restoredProductIds" has an unexpected shape',
      ],
      [
        'restoredProductIds (non-string element)',
        { restoredProductIds: ['product-1', 5] },
        'Checkout script result field "restoredProductIds" is an array containing non-string values',
      ],
      [
        'underflow (malformed entry)',
        { underflow: [{ productId: 'product-1' }] },
        'Checkout script result field "underflow[0]" has an unexpected shape',
      ],
      [
        'underflow (not an array or empty object)',
        { underflow: 'not-an-array' },
        'Checkout script result field "underflow" has an unexpected shape',
      ],
      [
        'admissionSuspended',
        { admissionSuspended: 'yes' },
        'Checkout script result field "admissionSuspended" has an unexpected shape',
      ],
    ] as const)('throws on an unexpected %s shape', async (_label, overrides, message) => {
      redis.eval.mockResolvedValue(revertJson(overrides));
      await expect(service.checkoutRevert(cartId, checkoutKey, now)).rejects.toThrow(message);
    });
  });

  describe('finalizeCheckoutConsumption result mapping', () => {
    it('maps a full result with every array populated and sorted', async () => {
      redis.eval.mockResolvedValue(
        finalizeJson({
          finalizedProductIds: ['product-2', 'product-1'],
          skippedProductIds: ['product-4', 'product-3'],
        }),
      );

      const result = await service.finalizeCheckoutConsumption(cartId, checkoutKey);

      expect(result).toEqual({
        ok: true,
        finalizedProductIds: ['product-1', 'product-2'],
        skippedProductIds: ['product-3', 'product-4'],
        malformedProductIds: [],
        versionMismatchedProductIds: [],
        underflow: [],
        admissionSuspended: false,
      });
    });

    it('maps underflow entries with operationName finalizeCheckoutConsumption', async () => {
      redis.eval.mockResolvedValue(
        finalizeJson({
          finalizedProductIds: ['product-1'],
          underflow: [{ productId: 'product-1', reservationQuantity: 4, storedTotal: 1 }],
          admissionSuspended: true,
        }),
      );

      const result = await service.finalizeCheckoutConsumption(cartId, checkoutKey);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.underflow[0]).toMatchObject({
          productId: 'product-1',
          cartId,
          reservationQuantity: 4,
          storedTotal: 1,
          operationName: 'finalizeCheckoutConsumption',
        });
        expect(result.admissionSuspended).toBe(true);
      }
    });
  });

  describe('no internal retry loop', () => {
    it('calls eval exactly once for checkoutRevert even when it rejects', async () => {
      redis.eval.mockRejectedValue(new Error('boom'));
      await expect(service.checkoutRevert(cartId, checkoutKey, now)).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('calls eval exactly once for finalizeCheckoutConsumption even when it rejects', async () => {
      redis.eval.mockRejectedValue(new Error('boom'));
      await expect(service.finalizeCheckoutConsumption(cartId, checkoutKey)).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
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
          if (contents.includes('CheckoutReservationRecoveryService')) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
