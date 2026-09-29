import { RESERVATION_OBSERVATION_SCRIPT } from '../lua/reservation-observation-lua';
import { controlBytes, restrictionDigest } from '../../reservation-fence/types/product-reservation-restriction.types';
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

      expect(result).toEqual({ status: 'OK', reservedByOthers: 7 });
    });

    it('treats a missing stored total as zero', async () => {
      redis.get.mockResolvedValue(null);

      const result = await service.getReservedTotalExcludingCart('product-1', 'cart-1');

      expect(result).toEqual({ status: 'OK', reservedByOthers: 0 });
    });

    it('treats an empty excludingCartId as "exclude nothing" without querying a reservation key', async () => {
      redis.get.mockResolvedValue('10');

      const result = await service.getReservedTotalExcludingCart('product-1', '');

      expect(result).toEqual({ status: 'OK', reservedByOthers: 10 });
      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(redis.get).toHaveBeenCalledWith('inv:reserved:product-total:{product-1}');
    });

    it('reports undercounted own-cart accounting as suspect', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('2');
        if (key === 'inv:reserved:{cart-1}:product-1') {
          return Promise.resolve(cartScopedEntryJson({ quantity: 5 }));
        }
        return Promise.resolve(null);
      });

      const result = await service.getReservedTotalExcludingCart('product-1', 'cart-1');

      expect(result).toEqual({ status: 'SUSPECT' });
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

  // Phase 16A.0-C2: computeAvailableToPurchase and getAvailabilityWithSuspectStatus
  // now share one private calculation path (suspect-flag read, product-total
  // read, own-cart add-back, zero-floor). These tests prove that refactor
  // changed nothing observable about computeAvailableToPurchase's existing
  // contract, and that the two methods agree exactly when status is OK.
  describe('computeAvailableToPurchase / getAvailabilityWithSuspectStatus compatibility', () => {
    it('computeAvailableToPurchase still returns the same number as before the split', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve(null);
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('4');
        return Promise.resolve(null);
      });

      const available = await service.computeAvailableToPurchase('product-1', 10, '');

      expect(available).toBe(6);
    });

    it('computeAvailableToPurchase still returns exactly 0 on suspect, never a different value', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve('1');
        return Promise.resolve(null);
      });

      const available = await service.computeAvailableToPurchase('product-1', 100, '');

      expect(available).toBe(0);
    });

    it('getAvailabilityWithSuspectStatus returns a typed SUSPECT result instead of collapsing to 0', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve('1');
        return Promise.resolve(null);
      });

      const result = await service.getAvailabilityWithSuspectStatus('product-1', 100, '');

      expect(result).toEqual({ status: 'SUSPECT' });
    });

    it('getAvailabilityWithSuspectStatus returns the same numeric outcome as computeAvailableToPurchase when OK', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve(null);
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('3');
        return Promise.resolve(null);
      });

      const richer = await service.getAvailabilityWithSuspectStatus('product-1', 10, '');
      expect(richer).toEqual({ status: 'OK', available: 7 });

      const compat = await service.computeAvailableToPurchase('product-1', 10, '');
      expect(compat).toBe(7);
    });

    it('getAvailabilityWithSuspectStatus floors at zero exactly like computeAvailableToPurchase', async () => {
      redis.get.mockImplementation((key: string) => {
        if (key === 'inv:reserved:product-total-suspect:{product-1}') return Promise.resolve(null);
        if (key === 'inv:reserved:product-total:{product-1}') return Promise.resolve('20');
        return Promise.resolve(null);
      });

      const richer = await service.getAvailabilityWithSuspectStatus('product-1', 10, '');

      expect(richer).toEqual({ status: 'OK', available: 0 });
    });
  });

  describe('W3-O observation', () => {
    const tuple = { incarnation: 'incarnation-1', epoch: 1, revision: 1, phase: 'OPEN', protocol: 1, transitionId: 'transition-1' };
    const fence = { ...tuple, id: tuple.transitionId, status: 'ACKNOWLEDGED' };
    let restrictionRead: jest.Mock;
    let fenceRead: jest.Mock;
    let installationRead: jest.Mock;
    const control = (restricted = false) => controlBytes({ version: 1, productId: 'product-1', state: restricted ? 'RESTRICTED' : 'ALLOW',
      restrictionId: restricted ? 'restriction-1' : null, restrictionRevision: restricted ? 1 : 0, incarnation: tuple.incarnation, epoch: 1 });
    const reply = (overrides: Record<string, unknown> = {}) => JSON.stringify({ findings: ['CONSISTENT'],
      accounting: { storedTotal: 0, observedQuantityTotal: 0, difference: 0 }, control: control(), fence: JSON.stringify(tuple), ...overrides });
    beforeEach(() => {
      restrictionRead = jest.fn().mockResolvedValue(null);
      fenceRead = jest.fn().mockResolvedValue(fence);
      installationRead = jest.fn().mockResolvedValue(null);
      Object.assign(service, { observationPrisma: { reservationFenceTransition: { findFirst: fenceRead },
        productReservationRestriction: { findUnique: restrictionRead },
        productReservationRestrictionInstallation: { findUnique: installationRead } } });
      redis.eval.mockResolvedValue(reply());
    });
    it('uses only the bounded observer and never claims convergence for matching/empty observed inventory', async () => {
      const result = await service.observeProductReservations('product-1', ['cart-1']);
      expect(result).toMatchObject({ authority: 'NONE', physicalConvergenceProven: false,
        scope: 'OBSERVED_RESOURCES_ONLY', membershipCompleteness: 'UNPROVEN', findings: ['CONSISTENT'] });
      expect(result).not.toHaveProperty('repairedValue');
      expect(result).not.toHaveProperty('admissionSuspended');
      expect(result).not.toHaveProperty('staleMembersRemoved');
      expect(redis.eval).toHaveBeenCalledWith(RESERVATION_OBSERVATION_SCRIPT, expect.arrayContaining(['reservation:fence:control']),
        ['product-1', expect.any(Number), 100, '["cart-1"]']);
      expect(redis.get).not.toHaveBeenCalled();
    });
    it.each(['MISSING', 'EXTRA', 'QUANTITY_MISMATCH', 'MEMBERSHIP_UNCERTAIN'])('retains %s without granting authority', async finding => {
      redis.eval.mockResolvedValue(reply({ findings: [finding] }));
      const result = await service.observeProductReservations('product-1');
      expect(result.findings).toContain(finding);
      expect(result.authority).toBe('NONE');
      expect(result.physicalConvergenceProven).toBe(false);
      expect(result.membershipCompleteness).toBe('UNPROVEN');
    });
    it.each(['PREPARED', 'ENFORCED'])('reports durable %s without installation authority', async state => {
      restrictionRead.mockResolvedValue({ id: 'restriction-1', productId: 'product-1', state, restrictionRevision: 1, observationDigest: 'digest' });
      redis.eval.mockResolvedValue(reply({ control: control(true) }));
      const result = await service.observeProductReservations('product-1');
      expect(result.findings).toContain('RESTRICTION_' + state);
      expect(result.restriction.installation).toBe('NOT_PROVEN');
      expect(result.physicalConvergenceProven).toBe(false);
    });
    it('compares current installation bytes but never certifies convergence', async () => {
      restrictionRead.mockResolvedValue({ id: 'restriction-1', state: 'ENFORCED', restrictionRevision: 1, observationDigest: 'digest' });
      installationRead.mockResolvedValue({ acknowledgement: control(true), acknowledgementHash: restrictionDigest(control(true)) });
      redis.eval.mockResolvedValue(reply({ control: control(true) }));
      const result = await service.observeProductReservations('product-1');
      expect(result.restriction.installation).toBe('MATCHES_OBSERVED_TUPLE');
      expect(result.physicalConvergenceProven).toBe(false);
    });
    it('rejects historical installation evidence and product substitution', async () => {
      restrictionRead.mockResolvedValue({ id: 'restriction-1', state: 'ENFORCED', restrictionRevision: 1 });
      installationRead.mockResolvedValue({ acknowledgement: 'old-incarnation', acknowledgementHash: restrictionDigest('old-incarnation') });
      redis.eval.mockResolvedValue(reply({ control: control(true) }));
      expect((await service.observeProductReservations('product-1')).restriction.installation).toBe('NOT_PROVEN');
      redis.eval.mockResolvedValue(reply({ control: control(true).replace('product-1', 'product-2') }));
      const result = await service.observeProductReservations('product-1');
      expect(result.findings).toContain('MEMBERSHIP_UNCERTAIN');
      expect(result.restriction.crossStoreConsistency).toBe('UNPROVEN');
    });
    it('does not present changing durable reads as an atomic snapshot', async () => {
      fenceRead.mockResolvedValueOnce(fence).mockResolvedValueOnce({ ...fence, revision: 2 });
      const result = await service.observeProductReservations('product-1');
      expect(result.findings).toContain('INFRASTRUCTURE_UNCERTAIN');
      expect(result.restriction.crossStoreConsistency).toBe('UNPROVEN');
    });
    it.each([null, '{}', 'not json', '{"findings":["SAFE_TO_MUTATE"]}'])('rejects malformed protocol %s', async raw => {
      redis.eval.mockResolvedValue(raw);
      expect((await service.observeProductReservations('product-1')).findings).toEqual(['INFRASTRUCTURE_UNCERTAIN']);
    });
    it('transport failure is uncertainty, not zero or absence', async () => {
      redis.eval.mockRejectedValue(new Error('transport'));
      const result = await service.observeProductReservations('product-1');
      expect(result.accounting.storedTotal).toBeNull();
      expect(result.restriction.durableState).toBe('UNKNOWN');
      expect(result.findings).toEqual(['INFRASTRUCTURE_UNCERTAIN']);
    });
    it('rejects oversized expected sets and unsafe identities before I/O', async () => {
      await service.observeProductReservations('product-1', Array(101).fill('cart-1'));
      await service.observeProductReservations('product:{other}');
      expect(redis.eval).not.toHaveBeenCalled();
      expect(fenceRead).not.toHaveBeenCalled();
    });
    it('statically permits only literal read commands; no dynamic calls, scans or writes', () => {
      const calls = [...RESERVATION_OBSERVATION_SCRIPT.matchAll(/redis\.call\('([^']+)'/g)].map(m => m[1]);
      expect([...new Set(calls)].sort()).toEqual(['GET', 'SCARD', 'SISMEMBER', 'SMEMBERS', 'TYPE']);
      expect(RESERVATION_OBSERVATION_SCRIPT.match(/redis\./g)?.length).toBe(calls.length);
      expect(RESERVATION_OBSERVATION_SCRIPT.indexOf("redis.call('SCARD'")).toBeLessThan(RESERVATION_OBSERVATION_SCRIPT.indexOf("redis.call('SMEMBERS'"));
      expect(RESERVATION_OBSERVATION_SCRIPT).toContain('count > limit');
      expect(RESERVATION_OBSERVATION_SCRIPT).toContain("flag('MEMBERSHIP_UNCERTAIN')");
    });
  });
});
