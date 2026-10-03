import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutStaleSettlementService } from '../services/checkout-stale-settlement.service';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { completionReceiptHash } from '../../reservation-fence/services/checkout-settlement-evidence';
import { unitManifest } from './checkout-stale-settlement-test-helpers';

describe('Stale settlement continuation (adapter seams, no real Redis)', () => {
  function fixture() {
    const manifest = unitManifest();
    const repository = { loadObligation: jest.fn().mockResolvedValue(manifest),
      acknowledge: jest.fn<ReturnType<CheckoutRecoverySettlementRepository['acknowledge']>,
        Parameters<CheckoutRecoverySettlementRepository['acknowledge']>>().mockResolvedValue(true) };
    const authority = { register: jest.fn().mockResolvedValue({ key: 'grant', result: JSON.stringify({ code: 'ACCEPTED', value: true }) }) };
    const redis = { eval: jest.fn<ReturnType<RedisService['eval']>, Parameters<RedisService['eval']>>()
      .mockResolvedValue(JSON.stringify({ code: 'ACCEPTED', value: true })) };
    const service = new CheckoutStaleSettlementService(repository as unknown as CheckoutRecoverySettlementRepository,
      authority as unknown as CheckoutSettlementAuthorityService, redis as unknown as RedisService);
    return { manifest, repository, authority, redis, service };
  }
  it('rejects FAILED alone before any Redis observation or grant', async () => {
    const f = fixture(); f.repository.loadObligation.mockResolvedValue(null);
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'REJECTED' });
    expect(f.redis.eval).not.toHaveBeenCalled(); expect(f.authority.register).not.toHaveBeenCalled();
  });
  it.each(['REVERT_PENDING', 'SETTLED'] as const)('observes completion first for %s and never resubmits', async state => {
    const f = fixture(); f.manifest.state = state;
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(f.authority.register).not.toHaveBeenCalled(); expect(f.redis.eval).toHaveBeenCalledTimes(1);
    expect(() => completionReceiptHash(f.repository.acknowledge.mock.calls[0]![1], f.manifest)).not.toThrow();
  });
  it.each([false, 'throw'])('retained receipt plus failed acknowledgement (%s) does not resubmit', async failure => {
    const f = fixture();
    if (failure === false) f.repository.acknowledge.mockResolvedValue(false);
    else f.repository.acknowledge.mockRejectedValue(new Error('database unavailable'));
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'UNRESOLVED' });
    expect(f.authority.register).not.toHaveBeenCalled(); expect(f.redis.eval).toHaveBeenCalledTimes(1);
    f.repository.acknowledge.mockResolvedValue(true);
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(f.authority.register).not.toHaveBeenCalled(); expect(f.redis.eval).toHaveBeenCalledTimes(2);
  });
  it('missing receipt for SETTLED never authorizes a physical effect', async () => {
    const f = fixture(); f.manifest.state = 'SETTLED'; f.redis.eval.mockRejectedValue(new Error('missing'));
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'UNRESOLVED' });
    expect(f.authority.register).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses existing W5 and typed acknowledgement; lost reply=%s', async lost => {
    const f = fixture(); f.redis.eval.mockRejectedValueOnce(new Error('receipt absent'));
    if (lost) f.redis.eval.mockRejectedValueOnce(new Error('response lost'));
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(f.authority.register).toHaveBeenCalledWith(f.manifest.id, 'CHECKOUT_REVERT_DELETE_ONLY');
    expect(f.redis.eval.mock.calls[1]![0]).toBe(CHECKOUT_SETTLEMENT_REVERT_SCRIPT);
    expect(f.redis.eval).toHaveBeenCalledTimes(3); expect(f.repository.acknowledge).toHaveBeenCalledTimes(1);
  });
  it('timeout preserves pending authority for a fresh service to observe completion', async () => {
    const f = fixture(); f.redis.eval.mockRejectedValue(new Error('timeout'));
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'UNRESOLVED' });
    expect(f.repository.acknowledge).not.toHaveBeenCalled();
    f.redis.eval.mockResolvedValue(JSON.stringify({ code: 'ACCEPTED', value: true }));
    const fresh = new CheckoutStaleSettlementService(f.repository as unknown as CheckoutRecoverySettlementRepository,
      f.authority as unknown as CheckoutSettlementAuthorityService, f.redis as unknown as RedisService);
    expect(await fresh.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'SETTLED' });
    expect(f.authority.register).toHaveBeenCalledTimes(1);
  });
  it('rejected grant never executes W5', async () => {
    const f = fixture(); f.redis.eval.mockRejectedValueOnce(new Error('absent'));
    f.authority.register.mockResolvedValue({ key: 'grant', result: JSON.stringify({ code: 'FENCE_REJECTED' }) });
    expect(await f.service.continueStaleRecoverySettlement(f.manifest.id)).toEqual({ code: 'REJECTED' });
    expect(f.redis.eval).toHaveBeenCalledTimes(1);
  });
});
