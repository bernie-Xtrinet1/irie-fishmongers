import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutRecoveryAcquisitionEvidenceService } from '../services/checkout-recovery-acquisition-evidence.service';
import { READ_CHECKOUT_ACQUISITION_SCRIPT } from '../../inventory/lua/checkout-acquire-lua-scripts';
import { settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { FenceTuple } from '../../reservation-fence/types/reservation-fence.types';
import { unitManifest } from './checkout-stale-settlement-test-helpers';

describe('Prepared acquisition read-only proof', () => {
  function fixture() {
    const manifest = unitManifest(); manifest.state = 'PREPARED'; manifest.effect = null; manifest.settlementReplayId = null;
    const tuple: FenceTuple = { phase: 'OPEN', incarnation: manifest.incarnation, epoch: 1, revision: 1,
      protocol: 1, transitionId: manifest.captureTransitionId };
    const redis = { eval: jest.fn<ReturnType<RedisService['eval']>, Parameters<RedisService['eval']>>()
      .mockResolvedValue(JSON.stringify({ code: 'ACCEPTED', value: { acquired: true } })) };
    return { manifest, tuple, redis, service: new CheckoutRecoveryAcquisitionEvidenceService(redis as unknown as RedisService) };
  }
  it('passes locked ownership, checkout key and tuple to unchanged read-only script', async () => {
    const f = fixture(); expect(await f.service.provePreparedAcquired(f.manifest, f.tuple)).toBe(true);
    expect(f.redis.eval.mock.calls[0]![0]).toBe(READ_CHECKOUT_ACQUISITION_SCRIPT);
    expect(JSON.parse(String(f.redis.eval.mock.calls[0]![2][0]))).toEqual({ tuple: f.tuple,
      identity: settlementOwnershipIdentity(f.manifest), checkoutIdempotencyKey: f.manifest.operation.operationKey });
  });
  it.each(['DRAINING', 'FROZEN', 'RETIRED'] as const)('%s cannot prove PREPARED', async phase => {
    const f = fixture(); f.tuple.phase = phase;
    expect(await f.service.provePreparedAcquired(f.manifest, f.tuple)).toBe(false); expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it.each([null, '{}', 'malformed', '{"code":"FENCE_REJECTED"}', '{"code":"ACCEPTED","value":true}',
    '{"code":"ACCEPTED","value":{"acquired":false}}'])('unproven response %s fails closed', async reply => {
    const f = fixture(); f.redis.eval.mockResolvedValue(reply);
    expect(await f.service.provePreparedAcquired(f.manifest, f.tuple)).toBe(false);
  });
  it.each(['incarnation', 'epoch', 'sealed'] as const)('rejects mismatched %s before reading', async kind => {
    const f = fixture();
    if (kind === 'incarnation') f.tuple.incarnation = 'other';
    if (kind === 'epoch') f.tuple.epoch = 2;
    if (kind === 'sealed') f.manifest.sealed = false;
    expect(await f.service.provePreparedAcquired(f.manifest, f.tuple)).toBe(false); expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('read failure cannot manufacture acquisition', async () => {
    const f = fixture(); f.redis.eval.mockRejectedValue(new Error('timeout'));
    expect(await f.service.provePreparedAcquired(f.manifest, f.tuple)).toBe(false); expect(f.redis.eval).toHaveBeenCalledTimes(1);
  });
});
