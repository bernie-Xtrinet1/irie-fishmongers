import { settlementOwnershipIdentity } from './checkout-settlement-evidence';
import { Injectable } from '@nestjs/common';
import { CheckoutSettlementEffect } from '@prisma/client';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutSettlementRepository } from '../repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { REGISTER_SETTLEMENT_GRANT_LUA, settlementGrantKey } from '../lua/checkout-settlement.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';

// Inactive issuer preparation; no production caller or worker wires this class.
@Injectable()
export class CheckoutSettlementAuthorityService {
  constructor(private readonly manifests: CheckoutSettlementRepository,
    private readonly fences: ReservationFenceRepository, private readonly redis: RedisService) {}

  register(manifestId: string, action: 'ACQUIRE' | CheckoutSettlementEffect) {
    return this.fences.locked(async tx => {
      await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id = ${manifestId}::uuid FOR UPDATE`;
      const { manifest: m, tuple } = await this.manifests.authority(tx, manifestId, action);
      const identity = settlementOwnershipIdentity(m);
      const replayId = action === 'ACQUIRE' ? m.acquisitionReplayId : m.settlementReplayId;
      const key = settlementGrantKey(randomUUID());
      const result: unknown = JSON.parse(await this.redis.eval(REGISTER_SETTLEMENT_GRANT_LUA,
        [RESERVATION_FENCE_KEY, key], [JSON.stringify({ tuple, identity, action, replayId,
          checkoutIdempotencyKey: m.operation.operationKey })]) as string);
      return { key, result };
    });
  }
}
