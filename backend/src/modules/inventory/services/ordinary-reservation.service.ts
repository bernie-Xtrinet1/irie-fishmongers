import { Injectable } from '@nestjs/common';
import {
  currentAllowedControlRevision,
  requireUnrestrictedProduct,
} from '../../reservation-fence/repositories/product-reservation-restriction.repository';
import { PRODUCT_CONTROL_INSTALL } from '../../reservation-fence/lua/product-reservation-restriction.lua';
import { controlBytes, productControlKey } from '../../reservation-fence/types/product-reservation-restriction.types';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { OrdinaryReservationAuthorization } from '../../reservation-fence/types/ordinary-reservation-authorization';
import { MutationResult, ResourceAuthority } from '../../reservation-fence/types/reservation-mutation.types';
import { UUID_PATTERN, legalPair } from '../../reservation-fence/types/reservation-fence.types';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { decodeMutationResult } from '../../reservation-fence/services/reservation-fenced-executor.service';
import { OBSERVE_ORDINARY_RESERVATION, REGISTER_ORDINARY_RESERVATION, WRITE_ORDINARY_RESERVATION } from '../lua/ordinary-reservation-lua';
import type { CartScopedReservationEntry } from './inventory-reservations.service';

const rejected = { code: 'FENCE_REJECTED', reason: 'PERMIT_SCOPE_MISMATCH' } as const;
function isEntry(value: unknown): value is CartScopedReservationEntry {
  return !!value && typeof value === 'object' && 'status' in value && value.status === 'ACTIVE' &&
    'quantity' in value && Number.isInteger(value.quantity);
}

@Injectable()
export class OrdinaryReservationService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async reserve(cartId: string, productId: string, customerId: string, quantity: number): Promise<MutationResult<CartScopedReservationEntry>> {
    if (![cartId, productId, customerId].every(id => UUID_PATTERN.test(id)) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 2147483647) return rejected;
    const fences = new ReservationFenceRepository(this.prisma);
    try {
      return await fences.locked(async tx => {
        const fence = await fences.latest(tx), mode = await fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision)
          return { code: 'FENCE_REJECTED', reason: 'DURABLE_REDIS_DISAGREEMENT' };
        if (fence.phase !== 'OPEN' || !legalPair(mode.mode, 'OPEN', true))
          return { code: 'FENCE_REJECTED', reason: 'PHASE_DENIED' };
        if (!await tx.cart.findFirst({ where: { id: cartId, customerId } })) return rejected;
        const markers = await tx.$queryRaw<{ id: string; generation: number; expectedQuantity: number | null }[]>`
          SELECT id,generation,"expectedQuantity" FROM cart_reservation_sync_states
          WHERE "cartId"=${cartId} AND "productId"=${productId} FOR UPDATE`;
        const marker = markers[0];
        if (!marker || marker.expectedQuantity !== quantity) return rejected;
        try {
          await requireUnrestrictedProduct(tx, productId);
        } catch (error) {
          if (error instanceof Error && error.message === 'PRODUCT_RESERVATION_RESTRICTED') {
            return { code: 'FENCE_REJECTED', reason: 'CAPABILITY_REVOKED' };
          }
          throw error;
        }
        const controlRevision = await currentAllowedControlRevision(tx, productId);
        const productControl = controlBytes({ version: 1, productId, state: 'ALLOW', restrictionId: null,
          restrictionRevision: controlRevision, incarnation: fence.incarnation, epoch: fence.epoch });
        const initialized = decodeMutationResult(await this.redis.eval(PRODUCT_CONTROL_INSTALL,
          [RESERVATION_FENCE_KEY, productControlKey(productId)], [JSON.stringify(transitionTuple(fence)), productControl]),
        (value): value is string => value === productControl);
        if (initialized.code !== 'ACCEPTED') return initialized;
        const target: ResourceAuthority = { cartId, productId, customerId, markerId: marker.id,
          generation: marker.generation, holdInstanceId: ordinaryHoldInstanceId(marker.id, marker.generation) };
        // Redis selects no identity: it may only match one of the durable-derived
        // source candidates. Lua rechecks the entire source before any write.
        const raw = await this.redis.get(resourceGuardKey(marker.id));
        let from: ResourceAuthority | null = null;
        if (raw !== null) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return { code: 'FENCE_REJECTED', reason: 'MALFORMED_RESOURCE_GUARD' };
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('resource' in parsed) ||
            !parsed.resource || typeof parsed.resource !== 'object' || Array.isArray(parsed.resource)) {
            return { code: 'FENCE_REJECTED', reason: 'MALFORMED_RESOURCE_GUARD' };
          }
          const guard = parsed as { resource: ResourceAuthority };
          const previous = marker.generation > 0 ? { ...target, generation: marker.generation - 1,
            holdInstanceId: ordinaryHoldInstanceId(marker.id, marker.generation - 1) } : null;
          const same = (candidate: ResourceAuthority) => Object.entries(candidate).every(([key, value]) =>
            guard.resource?.[key as keyof ResourceAuthority] === value);
          from = same(target) ? target : previous && same(previous) ? previous : null;
          if (!from) return { code: 'FENCE_REJECTED', reason: 'RESOURCE_GENERATION_MISMATCH' };
        }
        const authorization: OrdinaryReservationAuthorization = { version: 1, tuple: transitionTuple(fence),
          from, target, quantity, requestId: randomUUID(), expiresAt: 1, controlRevision };
        const keys = [RESERVATION_FENCE_KEY, `reservation:fence:w1:${authorization.requestId}`];
        const registered = decodeMutationResult(await this.redis.eval(REGISTER_ORDINARY_RESERVATION, keys,
          [JSON.stringify(authorization)]), (value): value is OrdinaryReservationAuthorization =>
          !!value && typeof value === 'object' && 'requestId' in value && value.requestId === authorization.requestId);
        if (registered.code !== 'ACCEPTED') return registered;
        const args = [JSON.stringify(registered.value)];
        try {
          const result = decodeMutationResult(await this.redis.eval(WRITE_ORDINARY_RESERVATION, keys, args), isEntry);
          if (result.code !== 'INFRASTRUCTURE_FAILURE') return result;
        } catch { /* An absent response is not evidence that execution failed. */ }
        const observed = decodeMutationResult(await this.redis.eval(OBSERVE_ORDINARY_RESERVATION, keys, args), isEntry);
        return observed.code === 'ACCEPTED' ? observed : { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' };
      });
    } catch { return { code: 'INFRASTRUCTURE_FAILURE', outcome: 'UNCERTAIN' }; }
  }
}
