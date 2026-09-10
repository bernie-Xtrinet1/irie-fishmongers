import { RedisService } from '../../../common/redis/redis.service';
import { compileFencedMutation, mutationGuard } from '../lua/reservation-mutation-guard.lua';
import { ReservationFencedExecutor, decodeMutationResult } from '../services/reservation-fenced-executor.service';
import { MutationEffect, MutationPermit, MUTATION_REJECTIONS } from '../types/reservation-mutation.types';

describe('G.4b.2a typed decoder and compiled execution boundary', () => {
  const isTrue = (v: unknown): v is true => v === true;
  it.each(MUTATION_REJECTIONS)('preserves %s without domain translation', reason => {
    expect(decodeMutationResult(JSON.stringify({ code: 'FENCE_REJECTED', reason }), isTrue))
      .toEqual({ code: 'FENCE_REJECTED', reason });
  });
  it.each(['invalid', '{}', 'null', '{"code":"ACCEPTED","value":false}', '{"code":"FENCE_REJECTED","reason":"invented"}'])
    ('malformed response is uncertain %#', raw => {
      expect(decodeMutationResult(raw, isTrue)).toEqual({ code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' });
    });
  it('retains ownership and bounded domain failures separately', () => {
    expect(decodeMutationResult('{"code":"OWNERSHIP_CONFLICT"}', isTrue)).toEqual({ code: 'OWNERSHIP_CONFLICT' });
    expect(decodeMutationResult('{"code":"DOMAIN_FAILURE","reason":"RESERVATION_MISSING"}', isTrue))
      .toEqual({ code: 'DOMAIN_FAILURE', reason: 'RESERVATION_MISSING' });
  });
  it('rejects arbitrary effect strings at compilation', () => {
    expect(() => mutationGuard("RELEASE'; return accepted() --" as MutationEffect)).toThrow('Unsupported');
  });
  it('rejects an uncompiled script without touching Redis', async () => {
    const redis = { eval: jest.fn() };
    const executor = new ReservationFencedExecutor(redis as unknown as RedisService);
    expect(await executor.execute({ source: 'return 1' }, {} as MutationPermit, [], [], isTrue))
      .toEqual({ code: 'FENCE_REJECTED', reason: 'PROTOCOL_MISMATCH' });
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('does not retry uncertain transport failure or return its sensitive message', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('private payload')) };
    const executor = new ReservationFencedExecutor(redis as unknown as RedisService);
    const result = await executor.execute(compileFencedMutation('RESERVE', 'return accepted()'),
      { permitId: 'fixture' } as MutationPermit, [], [], isTrue);
    expect(result).toEqual({ code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' });
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});
