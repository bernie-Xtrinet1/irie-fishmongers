import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutSettlementRepository, SettlementManifest } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';
import { settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { CHECKOUT_ACQUIRE_SCRIPT, READ_CHECKOUT_ACQUISITION_SCRIPT } from '../../inventory/lua/checkout-acquire-lua-scripts';

declare const acquisitionBrand: unique symbol;
export interface CheckoutAcquisitionEvidence { readonly [acquisitionBrand]: true }
const verified = new WeakMap<CheckoutAcquisitionEvidence, SettlementManifest>();

// Only the orchestrator can mint this process-local proof. A restart must read
// durable provenance and re-verify physical evidence; callers cannot supply it.
export function acquiredManifest(evidence: CheckoutAcquisitionEvidence): SettlementManifest {
  const manifest = verified.get(evidence);
  if (!manifest) throw new Error('ACQUISITION_EVIDENCE_REQUIRED');
  return structuredClone(manifest);
}

export type CheckoutAcquisitionResult =
  | { ok: true; evidence: CheckoutAcquisitionEvidence }
  | { ok: false; code: 'ACQUISITION_REJECTED' | 'ACQUISITION_UNCERTAIN' };

type PhysicalResult = { code: 'ACCEPTED'; acquired?: boolean } | { code: 'FENCE_REJECTED' };
function physicalResult(raw: unknown): PhysicalResult {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value && typeof value === 'object' && 'code' in value) {
    if (value.code === 'FENCE_REJECTED') return { code: 'FENCE_REJECTED' };
    if (value.code === 'ACCEPTED' && 'value' in value) {
      if (value.value === true) return { code: 'ACCEPTED' };
      if (value.value && typeof value.value === 'object' && 'acquired' in value.value &&
        typeof value.value.acquired === 'boolean') return { code: 'ACCEPTED', acquired: value.value.acquired };
    }
  }
  throw new Error('ACQUISITION_RESPONSE_UNCERTAIN');
}

// Provided only by the inactive dispatcher. No terminal action, failure
// transition, recovery ownership, or raw checkout-mark fallback exists here.
@Injectable()
export class CheckoutAcquisitionService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly manifests: CheckoutSettlementRepository, private readonly fences: ReservationFenceRepository,
    private readonly authority: CheckoutSettlementAuthorityService,
    private readonly metadata: ReservationMutationAuthorityService) {}

  async acquire(customerId: string, operationId: string): Promise<CheckoutAcquisitionResult> {
    const rejected = { ok: false, code: 'ACQUISITION_REJECTED' } as const;
    try {
      const operation = await this.prisma.checkoutOperation.findFirst({ where: { id: operationId, customerId } });
      if (!operation || operation.selectedPath !== 'CART_SCOPED' || !operation.reservationExecutionEpoch ||
        operation.reservationCapabilityState !== 'ACTIVE') return rejected;
      const attempt = await this.prisma.checkoutAttempt.findUnique({ where: { idempotencyKey: operation.operationKey } });
      if (!attempt || attempt.status !== 'PROCESSING' || attempt.customerId !== customerId ||
        attempt.cartId !== operation.cartId || attempt.selectedPath !== 'CART_SCOPED' ||
        attempt.reservationExecutionEpoch !== operation.reservationExecutionEpoch) return rejected;
      // prepare is PG-only and returns the original sealed manifest on replay.
      const manifest = await this.manifests.prepare(operation.id, attempt.id, customerId);
      if (!['PREPARED', 'ACQUIRED'].includes(manifest.state) || manifest.settlementReplayId !== null) return rejected;

      const gate = await this.metadata.initializeExecutionGate(operation.id, customerId);
      if (gate.code !== 'ACCEPTED') return gate.code === 'INFRASTRUCTURE_FAILURE'
        ? { ok: false, code: 'ACQUISITION_UNCERTAIN' } : rejected;
      let observation = await this.observe(manifest);
      if (observation.code !== 'ACCEPTED') return rejected;
      if (!observation.acquired) {
        if (manifest.state === 'ACQUIRED') return rejected;
        // Ordinary ownership must already exist. W4 never initializes, repairs
        // or advances a guard to make a physical hold match its manifest.
        const grant = await this.authority.register(manifest.id, 'ACQUIRE');
        if (physicalResult(grant.result).code !== 'ACCEPTED') return rejected;
        const result = physicalResult(await this.redis.eval(CHECKOUT_ACQUIRE_SCRIPT,
          [RESERVATION_FENCE_KEY, grant.key], []));
        if (result.code !== 'ACCEPTED') return rejected;
        // A protocol replay response alone is insufficient: check live domain
        // entries as well as receipt, every pin, guard and execution gate.
        observation = await this.observe(manifest);
        if (observation.code !== 'ACCEPTED' || !observation.acquired) return { ok: false, code: 'ACQUISITION_UNCERTAIN' };
      }
      const acquired = await this.fences.locked(async tx => {
        await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id = ${manifest.id}::uuid FOR UPDATE`;
        const current = await this.manifests.find(manifest.id, tx);
        if (!current || settlementOwnershipIdentity(current) !== settlementOwnershipIdentity(manifest) ||
          current.attempt.status !== 'PROCESSING' || current.settlementReplayId !== null)
          throw new Error('ACQUISITION_ACKNOWLEDGEMENT_UNRESOLVED');
        if (current.state === 'PREPARED') {
          await this.manifests.authority(tx, current.id, 'ACQUIRE');
          if ((await this.manifests.markAcquired(tx, current.id)).count !== 1)
            throw new Error('ACQUISITION_ACKNOWLEDGEMENT_UNRESOLVED');
        } else if (current.state !== 'ACQUIRED') throw new Error('ACQUISITION_ACKNOWLEDGEMENT_UNRESOLVED');
        return { ...current, state: 'ACQUIRED' as const };
      });
      const evidence = Object.freeze({}) as CheckoutAcquisitionEvidence;
      verified.set(evidence, acquired);
      return { ok: true, evidence };
    } catch {
      // In particular, a lost eval/commit response is not proof of failure.
      // Preserve the original PREPARED/ACQUIRED row and acquisition replay ID.
      return { ok: false, code: 'ACQUISITION_UNCERTAIN' };
    }
  }

  private observe(manifest: SettlementManifest): Promise<PhysicalResult> {
    return this.fences.locked(async tx => {
      const fence = await this.fences.latest(tx);
      const mode = await this.fences.mode(tx);
      if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.mode !== 'CART_SCOPED' ||
        mode.mode !== fence.mode || mode.modeRevision !== fence.modeRevision ||
        manifest.incarnation !== fence.incarnation || manifest.reservationExecutionEpoch !== fence.epoch)
        return { code: 'FENCE_REJECTED' };
      return physicalResult(await this.redis.eval(READ_CHECKOUT_ACQUISITION_SCRIPT, [RESERVATION_FENCE_KEY],
        [JSON.stringify({ tuple: transitionTuple(fence), identity: settlementOwnershipIdentity(manifest),
          checkoutIdempotencyKey: manifest.operation.operationKey })]));
    });
  }
}
