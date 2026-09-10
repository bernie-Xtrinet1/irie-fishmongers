import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { MutationPermit, MutationResult, MUTATION_REJECTIONS } from '../types/reservation-mutation.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { mutationPermitKey } from '../lua/reservation-mutation-common.lua';
import { CompiledFencedMutation, isCompiledFencedMutation } from '../lua/reservation-mutation-guard.lua';

export function decodeMutationResult<T>(raw: unknown, isValue: (v: unknown) => v is T): MutationResult<T> {
  const uncertain = { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' } as const;
  if (typeof raw !== 'string') return uncertain;
  try {
    const r: unknown = JSON.parse(raw);
    if (!r || typeof r !== 'object') return uncertain;
    const value = r as Record<string, unknown>;
    if (value.code === 'ACCEPTED' && isValue(value.value)) return { code: 'ACCEPTED', value: value.value };
    if (value.code === 'FENCE_REJECTED' && MUTATION_REJECTIONS.some(reason => reason === value.reason))
      return { code: 'FENCE_REJECTED', reason: value.reason as typeof MUTATION_REJECTIONS[number] };
    if (value.code === 'OWNERSHIP_CONFLICT') return { code: 'OWNERSHIP_CONFLICT' };
    if (value.code === 'DOMAIN_FAILURE' && typeof value.reason === 'string' && /^[A-Z_]{1,64}$/.test(value.reason))
      return { code: 'DOMAIN_FAILURE', reason: value.reason };
    return uncertain;
  } catch { return uncertain; }
}

@Injectable()
export class ReservationFencedExecutor {
  constructor(private readonly redis: RedisService) {}

  // No retry: a transport error cannot prove whether a future writer executed.
  async execute<T>(compiledScript: CompiledFencedMutation, permit: MutationPermit, keys: string[], args: string[],
    isValue: (v: unknown) => v is T): Promise<MutationResult<T>> {
    try {
      if (!isCompiledFencedMutation(compiledScript)) return { code: 'FENCE_REJECTED', reason: 'PROTOCOL_MISMATCH' };
      return decodeMutationResult(await this.redis.eval(compiledScript.source,
        [RESERVATION_FENCE_KEY, mutationPermitKey(permit.permitId), ...keys],
        [JSON.stringify(permit), ...args]), isValue);
    } catch { return { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' }; }
  }
}
