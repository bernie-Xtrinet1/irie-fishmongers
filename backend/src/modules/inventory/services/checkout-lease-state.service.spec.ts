import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';

// CheckoutLeaseStateService coverage: input validation, KEYS/ARGV
// construction, scriptVersion protocol, every failure-code mapping,
// result-array normalization/sorting, and no-caller-wiring. Real-Redis
// scenarios (actual Lua classification/priority/extension behavior) live
// in the separate checkout-lease-state.redis.integration.spec.ts and
// checkout-lease-extension.redis.integration.spec.ts files.
describe('CheckoutLeaseStateService', () => {
  let redis: jest.Mocked<Pick<RedisService, 'eval'>>;
  let service: CheckoutLeaseStateService;

  const cartId = 'cart-1';
  const checkoutKey = 'checkout-key-1';
  const now = 1_000_000;

  beforeEach(() => {
    redis = { eval: jest.fn() };
    service = new CheckoutLeaseStateService(redis as unknown as RedisService);
  });

  function leaseStateJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      scriptVersion: 1,
      ok: true,
      found: false,
      complete: false,
      allOwnedByCheckoutKey: false,
      earliestCheckoutPendingAt: null,
      earliestCheckoutPendingExpiresAt: null,
      latestCheckoutPendingExpiresAt: null,
      pendingProductIds: [],
      activeStatusProductIds: [],
      missingProductIds: [],
      malformedProductIds: [],
      versionMismatchedProductIds: [],
      conflictingKeyProductIds: [],
      expiredLeaseProductIds: [],
      hardLimitViolationProductIds: [],
      ...overrides,
    });
  }

  function extendSuccessJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      scriptVersion: 1,
      ok: true,
      alreadyExtended: false,
      newCheckoutPendingExpiresAt: 2_000_000,
      extendedProductIds: [],
      ...overrides,
    });
  }

  describe('getCheckoutPendingLeaseState input validation', () => {
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
        const result = await service.getCheckoutPendingLeaseState(givenCartId, givenKey, givenNow);
        expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field, reason });
        expect(redis.eval).not.toHaveBeenCalled();
      },
    );
  });

  describe('extendCheckoutLease input validation', () => {
    it('rejects an empty cartId without calling eval', async () => {
      const result = await service.extendCheckoutLease('', checkoutKey, now, 60);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot be empty',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-positive additionalSeconds without calling eval', async () => {
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 0);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'additionalSeconds',
        reason: 'additionalSeconds must be a positive integer',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('rejects a non-integer additionalSeconds without calling eval', async () => {
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 1.5);
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'additionalSeconds',
        reason: 'additionalSeconds must be a positive integer',
      });
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('KEYS/ARGV construction', () => {
    it('builds the exact keys and args for getCheckoutPendingLeaseState', async () => {
      redis.eval.mockResolvedValue(leaseStateJson());

      await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(typeof script).toBe('string');
      expect(keys).toEqual(['inv:reserved:cart-index:{cart-1}']);
      expect(args).toEqual([cartId, checkoutKey, now, 600_000]);
    });

    it('builds the exact keys and args for extendCheckoutLease', async () => {
      redis.eval.mockResolvedValue(extendSuccessJson());

      await service.extendCheckoutLease(cartId, checkoutKey, now, 60);

      const [, keys, args] = redis.eval.mock.calls[0]!;
      expect(keys).toEqual(['inv:reserved:cart-index:{cart-1}']);
      expect(args).toEqual([cartId, checkoutKey, now, 60_000, 600_000]);
    });
  });

  describe('scriptVersion protocol', () => {
    it('accepts a matching scriptVersion on getCheckoutPendingLeaseState', async () => {
      redis.eval.mockResolvedValue(leaseStateJson());
      const result = await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);
      expect(result.ok).toBe(true);
    });

    it('throws when scriptVersion is missing', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ ok: true, found: false }));
      await expect(service.getCheckoutPendingLeaseState(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script result is missing a numeric scriptVersion',
      );
    });

    it('throws when scriptVersion does not match the supported version', async () => {
      redis.eval.mockResolvedValue(leaseStateJson({ scriptVersion: 2 }));
      await expect(service.getCheckoutPendingLeaseState(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script returned unsupported scriptVersion 2',
      );
    });

    it('throws when the script does not return a string result', async () => {
      redis.eval.mockResolvedValue(null);
      await expect(service.getCheckoutPendingLeaseState(cartId, checkoutKey, now)).rejects.toThrow(
        'Checkout script did not return a JSON string result',
      );
    });

    it('accepts a matching scriptVersion on extendCheckoutLease', async () => {
      redis.eval.mockResolvedValue(extendSuccessJson());
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result.ok).toBe(true);
    });

    it('throws when extendCheckoutLease scriptVersion is unsupported', async () => {
      redis.eval.mockResolvedValue(extendSuccessJson({ scriptVersion: 3 }));
      await expect(service.extendCheckoutLease(cartId, checkoutKey, now, 60)).rejects.toThrow(
        'Checkout script returned unsupported scriptVersion 3',
      );
    });
  });

  describe('getCheckoutPendingLeaseState result mapping', () => {
    it('maps a full result with every field populated and sorted', async () => {
      redis.eval.mockResolvedValue(
        leaseStateJson({
          found: true,
          complete: true,
          allOwnedByCheckoutKey: true,
          earliestCheckoutPendingAt: 100,
          earliestCheckoutPendingExpiresAt: 200,
          latestCheckoutPendingExpiresAt: 300,
          pendingProductIds: ['product-2', 'product-1'],
          activeStatusProductIds: ['product-4', 'product-3'],
        }),
      );

      const result = await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);

      expect(result).toEqual({
        ok: true,
        found: true,
        complete: true,
        allOwnedByCheckoutKey: true,
        earliestCheckoutPendingAt: 100,
        earliestCheckoutPendingExpiresAt: 200,
        latestCheckoutPendingExpiresAt: 300,
        pendingProductIds: ['product-1', 'product-2'],
        activeStatusProductIds: ['product-3', 'product-4'],
        missingProductIds: [],
        malformedProductIds: [],
        versionMismatchedProductIds: [],
        conflictingKeyProductIds: [],
        expiredLeaseProductIds: [],
        hardLimitViolationProductIds: [],
      });
    });

    it('maps a populated, sorted hardLimitViolationProductIds', async () => {
      redis.eval.mockResolvedValue(
        leaseStateJson({ hardLimitViolationProductIds: ['product-2', 'product-1'] }),
      );

      const result = await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.hardLimitViolationProductIds).toEqual(['product-1', 'product-2']);
      }
    });

    it('treats an omitted timestamp key identically to an explicit null', async () => {
      const raw = JSON.parse(leaseStateJson()) as Record<string, unknown>;
      delete raw.earliestCheckoutPendingAt;
      redis.eval.mockResolvedValue(JSON.stringify(raw));

      const result = await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.earliestCheckoutPendingAt).toBeNull();
      }
    });

    it('normalizes an empty-object array field (cjson empty-table quirk) to []', async () => {
      redis.eval.mockResolvedValue(leaseStateJson({ pendingProductIds: {} }));
      const result = await service.getCheckoutPendingLeaseState(cartId, checkoutKey, now);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pendingProductIds).toEqual([]);
      }
    });

    it.each([
      ['found', { found: 'yes' }, 'Checkout script result field "found" has an unexpected shape'],
      [
        'pendingProductIds',
        { pendingProductIds: ['product-1', 5] },
        'Checkout script result field "pendingProductIds" is an array containing non-string values',
      ],
      [
        'earliestCheckoutPendingAt',
        { earliestCheckoutPendingAt: { foo: 'bar' } },
        'Checkout script result field "earliestCheckoutPendingAt" has an unexpected shape',
      ],
      [
        'pendingProductIds (string, not array/empty-object)',
        { pendingProductIds: 'not-an-array' },
        'Checkout script result field "pendingProductIds" has an unexpected shape',
      ],
    ] as const)('throws on an unexpected %s shape', async (_field, overrides, message) => {
      redis.eval.mockResolvedValue(leaseStateJson(overrides));
      await expect(service.getCheckoutPendingLeaseState(cartId, checkoutKey, now)).rejects.toThrow(
        message,
      );
    });
  });

  describe('extendCheckoutLease result mapping', () => {
    it('maps a success result with alreadyExtended true', async () => {
      redis.eval.mockResolvedValue(
        extendSuccessJson({ alreadyExtended: true, extendedProductIds: [] }),
      );
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result).toEqual({
        ok: true,
        alreadyExtended: true,
        newCheckoutPendingExpiresAt: 2_000_000,
        extendedProductIds: [],
      });
    });

    it('maps a success result with alreadyExtended false and sorted extendedProductIds', async () => {
      redis.eval.mockResolvedValue(
        extendSuccessJson({ alreadyExtended: false, extendedProductIds: ['product-2', 'product-1'] }),
      );
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result).toEqual({
        ok: true,
        alreadyExtended: false,
        newCheckoutPendingExpiresAt: 2_000_000,
        extendedProductIds: ['product-1', 'product-2'],
      });
    });

    it('throws when newCheckoutPendingExpiresAt has an unexpected shape', async () => {
      redis.eval.mockResolvedValue(extendSuccessJson({ newCheckoutPendingExpiresAt: '2000000' }));
      await expect(service.extendCheckoutLease(cartId, checkoutKey, now, 60)).rejects.toThrow(
        'Checkout script result field "newCheckoutPendingExpiresAt" has an unexpected shape',
      );
    });

    it('maps RESERVATION_NOT_PENDING with no extra fields', async () => {
      redis.eval.mockResolvedValue(JSON.stringify({ scriptVersion: 1, err: 'RESERVATION_NOT_PENDING' }));
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result).toEqual({ ok: false, code: 'RESERVATION_NOT_PENDING' });
    });

    it('maps CHECKOUT_STATE_INCOMPLETE with sorted pending/active product ids', async () => {
      redis.eval.mockResolvedValue(
        JSON.stringify({
          scriptVersion: 1,
          err: 'CHECKOUT_STATE_INCOMPLETE',
          pendingProductIds: ['product-2', 'product-1'],
          activeProductIds: ['product-4', 'product-3'],
        }),
      );
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result).toEqual({
        ok: false,
        code: 'CHECKOUT_STATE_INCOMPLETE',
        pendingProductIds: ['product-1', 'product-2'],
        activeProductIds: ['product-3', 'product-4'],
      });
    });

    it.each([
      'RESERVATION_MISSING',
      'RESERVATION_MALFORMED',
      'RESERVATION_VERSION_MISMATCH',
      'RESERVATION_CHECKOUT_KEY_MISMATCH',
      'CHECKOUT_PENDING_HARD_LIMIT_REACHED',
    ] as const)('maps %s with sorted productIds', async (code) => {
      redis.eval.mockResolvedValue(
        JSON.stringify({ scriptVersion: 1, err: code, productIds: ['product-2', 'product-1'] }),
      );
      const result = await service.extendCheckoutLease(cartId, checkoutKey, now, 60);
      expect(result).toEqual({ ok: false, code, productIds: ['product-1', 'product-2'] });
    });
  });

  describe('no internal retry loop', () => {
    it('calls eval exactly once even when it rejects', async () => {
      redis.eval.mockRejectedValue(new Error('boom'));
      await expect(service.getCheckoutPendingLeaseState(cartId, checkoutKey, now)).rejects.toThrow('boom');
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
          if (contents.includes('CheckoutLeaseStateService')) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
