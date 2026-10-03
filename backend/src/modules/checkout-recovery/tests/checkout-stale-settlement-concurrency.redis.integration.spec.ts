import { withStaleRedis } from './checkout-stale-settlement-test-helpers';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';

describe('Stale W5 concurrency (approved disposable Redis only)', () => {
  jest.setTimeout(120000);
  it('duplicate continuations share one action/replay and never decrement twice', () => withStaleRedis(async f => {
    await f.repository.authorizeStaleRecoverySettlement(f.candidate);
    const replay = (await f.manifests.find(f.manifest.id))!.settlementReplayId;
    await Promise.all([f.fresh().continueStaleRecoverySettlement(f.manifest.id), f.fresh().continueStaleRecoverySettlement(f.manifest.id)]);
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect((await f.snapshot()).total).toBe('0');
    expect((await f.manifests.find(f.manifest.id))!.settlementReplayId).toBe(replay);
  }));
  it('a completed physical effect with a lost reply is acknowledged through retained evidence', () => withStaleRedis(async f => {
    await f.repository.authorizeStaleRecoverySettlement(f.candidate);
    const original = f.evaluation.getMockImplementation()!;
    f.evaluation.mockImplementation(async (script, keys, args) => {
      const result = await original(script, keys, args);
      if (script === CHECKOUT_SETTLEMENT_REVERT_SCRIPT) throw new Error('Response lost after physical completion');
      return result;
    });
    expect(await f.fresh().continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect((await f.snapshot()).total).toBe('0');
  }));
});
