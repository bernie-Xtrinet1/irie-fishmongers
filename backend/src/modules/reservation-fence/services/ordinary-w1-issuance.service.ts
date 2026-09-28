import { OrdinaryReservationCommand, OrdinaryReservationOwner } from '@prisma/client';
import { requireUnrestrictedProduct } from '../repositories/product-reservation-restriction.repository';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { requireOrdinaryBarrierReadiness } from '../repositories/ordinary-invalidation.repository';
import { legalPair, MAX_FENCE_COUNTER, UUID_PATTERN } from '../types/reservation-fence.types';
import { ControlledOrdinaryIssuanceResult, OrdinaryAdmissionBinding, OrdinaryCommandAdmission } from '../types/ordinary-command-admission.types';

export interface OrdinaryW1Intent {
  markerId: string;
  generation: number;
  mutationVersion: number;
  customerId: string;
  cartId: string;
  productId: string;
  quantity: number;
}

export type OrdinaryW1IssuanceResult =
  | { status: 'DENIED'; reason: 'INVALID_INTENT' | 'AUTHORITY_REJECTED' }
  | { status: 'WAITING' | 'PENDING' | 'UNCERTAIN'; command: OrdinaryReservationCommand }
  | { status: 'ACKNOWLEDGED'; historical: true; command: OrdinaryReservationCommand };

// Standalone Stage A only. Deliberately not registered in any production module.
// Returning from fences.locked awaits COMMIT, including deferred constraints.
export class OrdinaryW1IssuanceService {
  private readonly fences: ReservationFenceRepository;
  private readonly owners: OrdinaryReservationOwnerRepository;
  private readonly commands: OrdinaryReservationCommandRepository;
  private readonly admissions = new WeakMap<object, OrdinaryAdmissionBinding>();

  constructor(prisma: PrismaService) {
    this.fences = new ReservationFenceRepository(prisma);
    this.owners = new OrdinaryReservationOwnerRepository(prisma);
    this.commands = new OrdinaryReservationCommandRepository(prisma);
  }

  async issue(input: OrdinaryW1Intent): Promise<OrdinaryW1IssuanceResult> {
    return (await this.issueWithInsertion(input)).result;
  }

  async issueForControlledDispatch(input: OrdinaryW1Intent): Promise<ControlledOrdinaryIssuanceResult> {
    const { result, inserted } = await this.issueWithInsertion(input);
    // No capability exists during the transaction. A failed/ambiguous COMMIT
    // returns inserted=false, even if the server actually persisted the command.
    if (!inserted || result.status === 'DENIED') return { issuance: result, admission: null };
    const admission = Object.freeze({}) as OrdinaryCommandAdmission;
    this.admissions.set(admission, structuredClone(result.command));
    return { issuance: result, admission };
  }

  consumeAdmission(admission: unknown): OrdinaryAdmissionBinding | null {
    if (typeof admission !== 'object' || admission === null) return null;
    const binding = this.admissions.get(admission);
    if (!binding) return null;
    this.admissions.delete(admission);
    return structuredClone(binding);
  }

  private async issueWithInsertion(input: OrdinaryW1Intent): Promise<{ result: OrdinaryW1IssuanceResult; inserted: boolean }> {
    if (!this.valid(input)) return { result: { status: 'DENIED', reason: 'INVALID_INTENT' }, inserted: false };
    const intent = { ...input };
    let inserted = false;
    try {
      const result = await this.fences.locked(async (tx): Promise<OrdinaryW1IssuanceResult> => {
        const fence = await this.fences.latest(tx);
        const mode = await this.fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.protocol !== 1
          || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision
          || !legalPair(mode.mode, fence.phase, true)) throw new Error('Fence rejected');
        const context = await this.owners.lockMarker(tx, intent.markerId);
        const { marker } = context;
        await requireUnrestrictedProduct(tx, marker.productId);
        await requireOrdinaryBarrierReadiness(tx, marker.id);
        const cart = await tx.cart.findUniqueOrThrow({ where: { id: marker.cartId } });
        if (marker.generation !== intent.generation || marker.expectedMutationVersion !== intent.mutationVersion
          || marker.cartId !== intent.cartId || marker.productId !== intent.productId
          || cart.customerId !== intent.customerId || marker.expectedQuantity !== intent.quantity)
          throw new Error('Intent rejected');

        const checkOwner = async (row: OrdinaryReservationOwner) => {
          await this.owners.loadAuthority(row.id, tx);
          if (row.markerId !== marker.id || row.cartId !== intent.cartId || row.customerId !== intent.customerId
            || row.productId !== intent.productId || row.incarnation !== fence.incarnation
            || row.reservationExecutionEpoch !== fence.epoch) throw new Error('Owner rejected');
        };
        const owners = await tx.ordinaryReservationOwner.findMany({ where: { markerId: marker.id },
          orderBy: [{ generation: 'asc' }, { id: 'asc' }] });
        let owner = owners.find(row => row.generation === intent.generation);
        if (owner) await checkOwner(owner);
        // Generation/version anchors detect contradictory quantities and owner
        // relationships rather than silently treating them as a new intent.
        const matches = await tx.ordinaryReservationCommand.findMany({ where: {
          markerId: marker.id, effect: 'W1', intentGeneration: intent.generation,
          expectedMutationVersion: intent.mutationVersion,
        } });
        if (matches.length > 1) throw new Error('Ambiguous intent');
        let command = matches[0];
        if (command) {
          await requireOrdinaryBarrierReadiness(tx, marker.id, command.id);
          if (!owner || command.ownerId !== owner.id || command.authorizedQuantity !== intent.quantity
            || command.reason !== 'CART_INTENT' || command.dependsOnCommandId !== null
            || command.cancelledCommandId !== null || command.checkoutManifestId !== null
            || command.settlementReceiptHash !== null || command.causeTransitionId !== null)
            throw new Error('Contradictory intent');
          if (command.w1Transition === 'INITIAL') {
            if (command.sourceOwnerId !== null) throw new Error('Initial source rejected');
          } else if (command.w1Transition === 'SAME_GENERATION') {
            if (command.sourceOwnerId !== owner.id) throw new Error('Same-generation source rejected');
          } else if (command.w1Transition === 'IMMEDIATE_PREDECESSOR') {
            const sourceOwnerId = command.sourceOwnerId;
            const source = owners.find(row => row.id === sourceOwnerId);
            if (!source || source.generation + 1 !== owner.generation) throw new Error('Predecessor rejected');
            await checkOwner(source);
            if (source.state !== (command.state === 'ACKNOWLEDGED' ? 'SUPERSEDED' : 'ACTIVE'))
              throw new Error('Unresolved predecessor');
          } else throw new Error('Transition rejected');
          if (command.state === 'ACKNOWLEDGED') {
            if (!command.completionReceiptHash || ['ISSUED', 'REVOKED'].includes(owner.state))
              throw new Error('Completion rejected');
            // A historical receipt says nothing about current physical liveness.
            return { status: 'ACKNOWLEDGED', historical: true, command };
          }
          if (!['WAITING', 'PENDING', 'UNCERTAIN'].includes(command.state)
            || !['ISSUED', 'ACTIVE'].includes(owner.state)) throw new Error('Losing authority');
        } else {
          let source: OrdinaryReservationOwner | undefined;
          let transition: 'INITIAL' | 'SAME_GENERATION' | 'IMMEDIATE_PREDECESSOR';
          if (owner) {
            if (owner.state !== 'ACTIVE') throw new Error('Unresolved owner');
            source = owner;
            transition = 'SAME_GENERATION';
          } else if (owners.length) {
            source = owners[owners.length - 1];
            if (!source) throw new Error('Missing predecessor');
            await checkOwner(source);
            if (source.generation + 1 !== intent.generation || source.state !== 'ACTIVE')
              throw new Error('Unresolved predecessor');
            transition = 'IMMEDIATE_PREDECESSOR';
          } else transition = 'INITIAL';
          if (!owner) owner = await this.owners.create(context, {
            markerId: marker.id, generation: intent.generation, cartId: intent.cartId,
            customerId: intent.customerId, productId: intent.productId,
            incarnation: fence.incarnation, reservationExecutionEpoch: fence.epoch, issuanceTransitionId: fence.id,
          });
          command = await this.commands.insert(context, { ownerId: owner.id, sourceOwnerId: source?.id,
            effect: 'W1', reason: 'CART_INTENT', w1Transition: transition,
            intentGeneration: intent.generation, expectedMutationVersion: intent.mutationVersion,
            authorizedQuantity: intent.quantity });
          // Only this transaction's actual INSERT establishes provenance. A
          // matching/reused row never takes this branch, including racing calls.
          inserted = true;
          await tx.cartReservationSyncState.update({ where: { id: marker.id }, data: { ordinaryProvenanceState: 'TRACKED' } });
        }
        if (command.state === 'WAITING') command = await this.commands.promoteLocked(context, command.id) ?? command;
        if (command.state !== 'WAITING' && command.state !== 'PENDING' && command.state !== 'UNCERTAIN')
          throw new Error('Unexpected command state');
        return { status: command.state, command };
      });
      return { result, inserted };
    } catch {
      // No result escapes a failed transaction/COMMIT. In particular, never
      // retry allocation after a uniqueness, lock, or ambiguous commit error.
      return { result: { status: 'DENIED', reason: 'AUTHORITY_REJECTED' }, inserted: false };
    }
  }

  private valid(intent: OrdinaryW1Intent): boolean {
    if (!intent || typeof intent !== 'object' || Object.keys(intent).sort().join(',')
      !== 'cartId,customerId,generation,markerId,mutationVersion,productId,quantity') return false;
    return [intent.markerId, intent.cartId, intent.customerId, intent.productId]
      .every(id => typeof id === 'string' && id.length === 36 && UUID_PATTERN.test(id))
      && [intent.generation, intent.mutationVersion, intent.quantity].every(n => Number.isInteger(n) && n >= 0 && n <= MAX_FENCE_COUNTER)
      && intent.quantity > 0;
  }
}
