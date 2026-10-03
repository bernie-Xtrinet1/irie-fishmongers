import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { readSettlementCompletion, SettlementCompletionEvidence } from '../../reservation-fence/services/checkout-settlement-evidence';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { StaleSettlementResult } from '../types/checkout-recovery-settlement.types';

function accepted(raw: unknown): boolean {
  const r: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof r !== 'object' || r === null || !('code' in r)) throw new Error('UNCERTAIN_SETTLEMENT_REPLY');
  if (r.code === 'FENCE_REJECTED') return false;
  if (r.code === 'ACCEPTED' && 'value' in r && (r.value === true
    || (typeof r.value === 'object' && r.value !== null && 'completed' in r.value && r.value.completed === true))) return true;
  throw new Error('UNCERTAIN_SETTLEMENT_REPLY');
}

@Injectable()
export class CheckoutStaleSettlementService {
  constructor(private readonly repository: CheckoutRecoverySettlementRepository,
    private readonly authority: CheckoutSettlementAuthorityService, private readonly redis: RedisService) {}

  async continueStaleRecoverySettlement(manifestId: string): Promise<StaleSettlementResult> {
    try {
      const m = await this.repository.loadObligation(manifestId);
      if (!m) return { code: 'REJECTED' };
      const acknowledge = async () => {
        try { return await this.repository.acknowledge(m, await readSettlementCompletion(this.redis, m)); }
        catch { return false; }
      };
      let retained: SettlementCompletionEvidence | undefined;
      try { retained = await readSettlementCompletion(this.redis, m); } catch { /* Unproven; W5 still validates exact ownership. */ }
      if (retained) return { code: await this.repository.acknowledge(m, retained) ? 'SETTLED' : 'UNRESOLVED' };
      if (m.state === 'SETTLED') return { code: 'UNRESOLVED' };
      const grant = await this.authority.register(m.id, 'CHECKOUT_REVERT_DELETE_ONLY');
      if (!accepted(grant.result)) return { code: 'REJECTED' };
      try {
        if (!accepted(await this.redis.eval(CHECKOUT_SETTLEMENT_REVERT_SCRIPT, [RESERVATION_FENCE_KEY, grant.key], [])))
          return { code: 'REJECTED' };
      } catch {
        // A lost reply can follow a completed effect. Observe, never raw retry.
        return { code: await acknowledge() ? 'SETTLED' : 'UNRESOLVED' };
      }
      return { code: await acknowledge() ? 'SETTLED' : 'UNRESOLVED' };
    } catch { return { code: 'UNRESOLVED' }; }
  }
}
