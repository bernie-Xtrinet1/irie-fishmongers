import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { READ_CHECKOUT_ACQUISITION_SCRIPT } from '../../inventory/lua/checkout-acquire-lua-scripts';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { FenceTuple } from '../../reservation-fence/types/reservation-fence.types';

// Internal observation only. The repository supplies a locked durable manifest;
// no public endpoint accepts an asserted result and no acquisition is executed.
@Injectable()
export class CheckoutRecoveryAcquisitionEvidenceService {
  constructor(private readonly redis: RedisService) {}

  async provePreparedAcquired(manifest: SettlementManifest, tuple: FenceTuple): Promise<boolean> {
    if (!manifest.sealed || manifest.state !== 'PREPARED' || tuple.phase !== 'OPEN'
      || manifest.incarnation !== tuple.incarnation || manifest.reservationExecutionEpoch !== tuple.epoch)
      return false;
    try {
      const raw: unknown = await this.redis.eval(READ_CHECKOUT_ACQUISITION_SCRIPT, [RESERVATION_FENCE_KEY],
        [JSON.stringify({ tuple, identity: settlementOwnershipIdentity(manifest),
          checkoutIdempotencyKey: manifest.operation.operationKey })]);
      if (typeof raw !== 'string') return false;
      const result: unknown = JSON.parse(raw);
      return typeof result === 'object' && result !== null && 'code' in result && result.code === 'ACCEPTED'
        && 'value' in result && typeof result.value === 'object' && result.value !== null
        && 'acquired' in result.value && result.value.acquired === true;
    } catch { return false; }
  }
}
