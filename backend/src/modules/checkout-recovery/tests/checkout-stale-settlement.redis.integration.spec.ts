import { withStaleRedis } from './checkout-stale-settlement-test-helpers';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';

describe('Stale W5 exact physical settlement (approved disposable Redis only)', () => {
  jest.setTimeout(120000);
  it('crash after atomic PG transition, fresh continuation, duplicate replay and totals', () => withStaleRedis(async f => {
    expect((await f.repository.authorizeStaleRecoverySettlement(f.candidate)).code).toBe('AUTHORIZED');
    expect(await f.repository.findPendingStaleSettlementsPage({ afterManifestId: null, limit: 100 })).toContainEqual({ id: f.manifest.id });
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    const settled = await f.snapshot(); expect(settled.entry).toBeNull(); expect(settled.total).toBe('0'); expect(settled.pin).toBeNull();
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(await f.snapshot()).toEqual(settled);
  }));
  it('exact retained receipt and failed PG acknowledgement never resubmits W5', () => withStaleRedis(async f => {
    await f.repository.authorizeStaleRecoverySettlement(f.candidate);
    const ack = jest.spyOn(f.repository, 'acknowledge').mockRejectedValue(new Error('PG acknowledgement unavailable'));
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'UNRESOLVED' });
    const register = jest.spyOn(f.authority, 'register'), physical = f.evaluation;
    physical.mockClear(); const before = await f.snapshot();
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'UNRESOLVED' });
    expect(register).not.toHaveBeenCalled(); expect(physical.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
    expect(await f.snapshot()).toEqual(before); ack.mockRestore();
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(await f.snapshot()).toEqual(before);
  }));
  it.each(['FROZEN', 'RETIRED'] as const)('%s rejects physical cleanup without writes', phase => withStaleRedis(async f => {
    await f.repository.authorizeStaleRecoverySettlement(f.candidate);
    await f.client.set(RESERVATION_FENCE_KEY, JSON.stringify({ ...transitionTuple(f.transition), phase }));
    const before = await f.snapshot();
    expect((await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).code).not.toBe('SETTLED');
    expect(await f.snapshot()).toEqual(before);
    expect((await f.manifests.find(f.manifest.id))!.state).toBe('REVERT_PENDING');
  }));
});
