import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { assertDisposableEnvironment, withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { executionGateKey, mutationPermitKey, resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { MutationPermit } from '../../reservation-fence/types/reservation-mutation.types';
import { cartIndexKey, reservationKey } from '../constants/inventory.constants';
import { CHECKOUT_EXTEND_LEASE_SCRIPT } from '../lua/checkout-lease-extend-lua-scripts';
import { CheckoutLeaseStateService } from './checkout-lease-state.service';
import { leasePermit } from './checkout-lease-permit.test-helper';
import { buildReservationEntryJson, seedRawReservation, trackCheckoutKeysFor } from './checkout-reservation-state.redis-test-helpers';

async function isolated(work: (f: {
  redis: Redis; permit: MutationPermit; call: (p: MutationPermit) => ReturnType<CheckoutLeaseStateService['extendCheckoutLease']>;
  tamperTarget: (targetMs: number) => Promise<unknown>;
  raw: () => Promise<string | null>; save: () => Promise<unknown>; now: number; cartId: string; productId: string;
}) => Promise<void>) {
  assertDisposableEnvironment();
  const redis = new Redis(process.env.REDIS_URL!);
  const keys = new Set<string>();
  await withCleanup(async () => {
    const cartId = randomUUID(), productId = randomUUID(), customerId = randomUUID(), checkoutKey = randomUUID();
    const now = Date.now();
    trackCheckoutKeysFor(keys, cartId, [productId]);
    await seedRawReservation(redis, cartId, productId, buildReservationEntryJson(now, {
      cartId, customerId, status: 'CHECKOUT_PENDING', checkoutIdempotencyKey: checkoutKey,
      checkoutPendingAt: now, checkoutPendingExpiresAt: now + 10000,
    }));
    const permit = await leasePermit(redis, keys, cartId, customerId, now, 60);
    const service = new CheckoutLeaseStateService(new RedisService(redis));
    await work({ redis, permit, now, cartId, productId,
      call: p => service.extendCheckoutLease(cartId, checkoutKey, now, p),
      // Deliberately bypass the service argument builder, never the Lua guard.
      tamperTarget: async targetMs => JSON.parse(await redis.eval(CHECKOUT_EXTEND_LEASE_SCRIPT.source, 3,
        RESERVATION_FENCE_KEY, mutationPermitKey(permit.permitId), cartIndexKey(cartId),
        JSON.stringify(permit), String(targetMs), cartId, checkoutKey, String(now)) as string) as unknown,
      raw: () => redis.get(reservationKey(cartId, productId)),
      save: () => redis.set(mutationPermitKey(permit.permitId), JSON.stringify(permit)),
    });
  }, [async () => { if (keys.size) await redis.del(...keys); }, () => redis.quit()]);
}

describe('G.4b.2b.2 W7 physical authorization', () => {
  it.each(['incarnation', 'epoch', 'revision'] as const)('rejects wrong %s without a write', field => isolated(async f => {
    const before = await f.raw();
    const tuple = { ...f.permit.tuple, [field]: field === 'incarnation' ? randomUUID() : 99 };
    expect(await f.call({ ...f.permit, tuple })).toMatchObject({ ok: false, code: 'FENCE_REJECTED' });
    expect(await f.raw()).toBe(before);
  }));
  it.each(['missing', 'malformed', 'expired', 'effect', 'purpose', 'phase', 'resource', 'closed', 'revoked', 'FROZEN', 'RETIRED'] as const)
    ('rejects %s authority before mutation', kind => isolated(async f => {
      const before = await f.raw();
      switch (kind) {
        case 'missing': await f.redis.del(mutationPermitKey(f.permit.permitId)); break;
        case 'malformed': await f.redis.set(mutationPermitKey(f.permit.permitId), '{}'); break;
        case 'expired': f.permit.expiresAt = 1; await f.save(); break;
        case 'effect': Object.assign(f.permit, { effect: 'CHECKOUT_MARK', constraint: { kind: 'NONE' } }); await f.save(); break;
        case 'purpose': f.permit.purpose = 'CHECKOUT_SETTLEMENT'; await f.save(); break;
        case 'phase': f.permit.authorizationPhase = 'DRAINING'; await f.save(); break;
        case 'resource': await f.redis.del(resourceGuardKey(f.permit.resources[0]!.markerId)); break;
        case 'closed': case 'revoked': {
          const key = executionGateKey(f.permit.execution!.gateId);
          const gate = JSON.parse((await f.redis.get(key))!) as Record<string, unknown>;
          await f.redis.set(key, JSON.stringify({ ...gate, state: kind === 'closed' ? 'CLOSED' : 'REVOKED' })); break;
        }
        case 'FROZEN': case 'RETIRED':
          f.permit.tuple.phase = kind;
          await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.permit.tuple)); await f.save(); break;
      }
      expect(await f.call(f.permit)).toMatchObject({ ok: false, code: 'FENCE_REJECTED' });
      expect(await f.raw()).toBe(before);
    }));
  it('rejects a missing argument before contacting Redis', () => isolated(async f => {
    const before = await f.raw();
    expect(await f.call(undefined as unknown as MutationPermit)).toEqual({ ok: false, code: 'FENCE_REJECTED', reason: 'MISSING_PERMIT' });
    expect(await f.raw()).toBe(before);
  }));
  it('binds the exact target on first execution and replay', () => isolated(async f => {
    const before = await f.raw();
    for (const target of [f.now + 59000, f.now + 61000]) {
      expect(await f.tamperTarget(target)).toMatchObject({ code: 'FENCE_REJECTED' });
      expect(await f.raw()).toBe(before);
    }
    expect(await f.call(f.permit)).toMatchObject({ ok: true, alreadyExtended: false, newCheckoutPendingExpiresAt: f.now + 60000 });
    const extended = await f.raw();
    expect(await f.call(f.permit)).toMatchObject({ ok: true, alreadyExtended: true });
    expect(await f.tamperTarget(f.now + 61000)).toMatchObject({ code: 'FENCE_REJECTED' });
    const forged: MutationPermit = { ...f.permit, effect: 'CHECKOUT_LEASE_EXTEND',
      constraint: { kind: 'LEASE_CEILING', ceilingMs: f.now + 61000 } };
    expect(await f.call(forged)).toMatchObject({ code: 'FENCE_REJECTED' });
    expect(await f.raw()).toBe(extended);
  }));
  it('accepts DRAINING only with matching registered authorization phase', () => isolated(async f => {
    f.permit.authorizationPhase = 'DRAINING'; f.permit.tuple.phase = 'DRAINING';
    await f.redis.set(RESERVATION_FENCE_KEY, JSON.stringify(f.permit.tuple)); await f.save();
    expect(await f.call(f.permit)).toMatchObject({ ok: true });
  }));
  it('rejects a member outside the resource list before touching owned entries', () => isolated(async f => {
    const before = await f.raw();
    const extra = randomUUID();
    const extraKey = reservationKey(f.cartId, extra);
    await withCleanup(async () => {
      await f.redis.set(extraKey, before!);
      await f.redis.sadd(cartIndexKey(f.cartId), extra);
      expect(await f.call(f.permit)).toMatchObject({ code: 'FENCE_REJECTED', reason: 'PERMIT_SCOPE_MISMATCH' });
      expect(await f.raw()).toBe(before);
      expect(await f.redis.get(extraKey)).toBe(before);
    }, [() => f.redis.del(extraKey)]);
  }));
  it('keeps physical ownership conflict distinct', () => isolated(async f => {
    const key = reservationKey(f.cartId, f.productId);
    const entry = JSON.parse((await f.raw())!) as Record<string, unknown>;
    await f.redis.set(key, JSON.stringify({ ...entry, customerId: randomUUID() }));
    const before = await f.raw();
    expect(await f.call(f.permit)).toEqual({ ok: false, code: 'OWNERSHIP_CONFLICT' });
    expect(await f.raw()).toBe(before);
  }));
  it('places the guard before the mutation and consumes its target', () => {
    const source = CHECKOUT_EXTEND_LEASE_SCRIPT.source;
    expect(source.indexOf('local authorizedLeaseTargetMs')).toBeLessThan(source.indexOf("redis.call('SET'"));
    expect(source).toContain('math.min(authorizedLeaseTargetMs, entry.checkoutPendingAt + maxPendingMs)');
    expect(source).not.toContain('now + additionalMs');
  });
});
