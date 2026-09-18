import { OrdinaryReservationCommand } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryDispatchClaim, OrdinaryDispatchClaimResult, OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { OrdinaryMarkerTransaction } from '../types/ordinary-reservation-provenance.types';
import { legalPair, UUID_PATTERN } from '../types/reservation-fence.types';
import { ReservationFenceRepository } from './reservation-fence.repository';
import { OrdinaryReservationOwnerRepository } from './ordinary-reservation-owner.repository';

// INACTIVE: only for a future controlled composition in which every physical
// submission is claim-gated. Zero attempts does NOT prove arbitrary older work
// was never executed by Stage B. No historical adoption API is provided here.
// The schema has no protocol-membership discriminator: production admission of
// commands into this contract requires a separately approved boundary.
export class OrdinaryCommandDispatchClaimRepository {
  private readonly fences: ReservationFenceRepository;
  private readonly owners: OrdinaryReservationOwnerRepository;
  private readonly grants = new WeakMap<OrdinaryDispatchClaim, OrdinaryDispatchIdentity>();

  constructor(private readonly prisma: PrismaService) {
    this.fences = new ReservationFenceRepository(prisma);
    this.owners = new OrdinaryReservationOwnerRepository(prisma);
  }

  async claim(expected: OrdinaryDispatchIdentity): Promise<OrdinaryDispatchClaimResult> {
    try {
      if (!expected || typeof expected.commandId !== 'string' || !UUID_PATTERN.test(expected.commandId))
        return { status: 'NOT_AUTHORIZED' };
      // Snapshot caller data before the first await. Comparison rejects extra
      // fields as well as altered immutable identity; callers use canonical order.
      const bytes = JSON.stringify(expected);
      const commandId = expected.commandId;
      const identity = await this.fences.locked(async tx => {
        const fence = await this.fences.latest(tx), mode = await this.fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN' || fence.protocol !== 1
          || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision || !legalPair(mode.mode, 'OPEN', true))
          throw new Error('CLAIM_FENCE_REJECTED');
        const reference = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
        const context = await this.owners.lockMarker(tx, reference.markerId);
        const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
        if (command.state !== 'PENDING' || command.attemptCount !== 0 || command.lastDispatchTransitionId !== null
          || command.nextAttemptAt !== null || command.expectedSequence !== context.marker.ordinaryAcknowledgedSequence
          || command.sequence === null || command.sequence > context.marker.ordinaryCommandSequence)
          throw new Error('CLAIM_ALREADY_CONSUMED_OR_INELIGIBLE');
        const actual = await this.identity(context, command);
        if (actual.incarnation !== fence.incarnation || actual.epoch !== fence.epoch || JSON.stringify(actual) !== bytes)
          throw new Error('CLAIM_IDENTITY_REJECTED');
        if (command.dependsOnCommandId) {
          const dependency = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.dependsOnCommandId } });
          if (dependency.markerId !== command.markerId || dependency.queueOrdinal >= command.queueOrdinal
            || !['ACKNOWLEDGED', 'CANCELLED'].includes(dependency.state)) throw new Error('CLAIM_DEPENDENCY_REJECTED');
        }
        const changed = await tx.ordinaryReservationCommand.updateMany({ where: {
          id: command.id, replayId: command.replayId, state: 'PENDING', attemptCount: 0,
          lastDispatchTransitionId: null, nextAttemptAt: null,
        }, data: { attemptCount: 1, lastDispatchTransitionId: fence.id, nextAttemptAt: null } });
        if (changed.count !== 1) throw new Error('CLAIM_CAS_REJECTED');
        return actual;
      });
      // This line is reached only after confirmed outer COMMIT. Ambiguous commit
      // loses the grant permanently; reading positive attempts cannot recover it.
      const claim = Object.freeze({}) as OrdinaryDispatchClaim;
      this.grants.set(claim, identity);
      return { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED', claim };
    } catch { return { status: 'NOT_AUTHORIZED' }; }
  }

  consume(claim: OrdinaryDispatchClaim): OrdinaryDispatchIdentity | null {
    const identity = this.grants.get(claim);
    if (!identity) return null;
    this.grants.delete(claim);
    return structuredClone(identity);
  }

  private async identity(context: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand): Promise<OrdinaryDispatchIdentity> {
    const { tx, marker } = context;
    if (command.markerId !== marker.id || command.sequence === null || command.expectedSequence === null
      || command.sequence <= command.expectedSequence) throw new Error('CLAIM_SEQUENCE_REJECTED');
    if (command.effect === 'CANCEL_W1') {
      const parent = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.cancelledCommandId! } });
      if (parent.effect !== 'W1' || parent.state !== 'REVOCATION_PENDING' || parent.ownerId !== command.ownerId
        || parent.markerId !== marker.id || parent.sequence === null || parent.sequence >= command.sequence
        || parent.queueOrdinal >= command.queueOrdinal || parent.expectedSequence !== command.expectedSequence
        || command.reason !== 'STALE_W1') throw new Error('CLAIM_PARENT_REJECTED');
      const p = await this.w1(context, parent, false);
      return { ...p, commandId: command.id, replayId: command.replayId, action: 'CANCEL_W1',
        sequence: command.sequence, expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion,
        transition: null, quantity: null, parent: JSON.stringify(p) };
    }
    return this.w1(context, command, true);
  }

  private async w1({ tx, marker }: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand, current: boolean): Promise<OrdinaryDispatchIdentity> {
    if (command.effect !== 'W1' || command.reason !== 'CART_INTENT' || command.authorizedQuantity === null
      || command.authorizedQuantity < 1 || command.sequence === null || command.expectedSequence === null
      || command.sequence <= command.expectedSequence || command.checkoutManifestId || command.cancelledCommandId
      || command.causeTransitionId || command.settlementReceiptHash) throw new Error('CLAIM_W1_REJECTED');
    const owner = await this.owners.loadAuthority(command.ownerId, tx);
    const source = command.sourceOwnerId ? await this.owners.loadAuthority(command.sourceOwnerId, tx) : null;
    if (owner.markerId !== marker.id || owner.generation !== command.intentGeneration || owner.cartId !== marker.cartId
      || owner.productId !== marker.productId || owner.checkoutManifestId || !['ISSUED', 'ACTIVE'].includes(owner.state)
      || (source && (source.markerId !== owner.markerId || source.cartId !== owner.cartId || source.productId !== owner.productId
        || source.customerId !== owner.customerId || source.incarnation !== owner.incarnation
        || source.reservationExecutionEpoch !== owner.reservationExecutionEpoch || source.state !== 'ACTIVE')))
      throw new Error('CLAIM_OWNER_REJECTED');
    if (current && (marker.generation !== command.intentGeneration || marker.expectedMutationVersion !== command.expectedMutationVersion
      || marker.expectedQuantity !== command.authorizedQuantity)) throw new Error('CLAIM_STALE_INTENT');
    if (!((command.w1Transition === 'INITIAL' && !source && owner.state === 'ISSUED')
      || (command.w1Transition === 'SAME_GENERATION' && source?.id === owner.id && owner.state === 'ACTIVE')
      || (command.w1Transition === 'IMMEDIATE_PREDECESSOR' && source && source.generation + 1 === owner.generation && owner.state === 'ISSUED')))
      throw new Error('CLAIM_TRANSITION_REJECTED');
    const resource = (o: typeof owner) => ({ customerId: o.customerId, cartId: o.cartId, productId: o.productId,
      markerId: o.markerId, generation: o.generation, holdInstanceId: o.holdInstanceId });
    return { version: 1, commandId: command.id, replayId: command.replayId, action: 'W1', sequence: command.sequence,
      expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion, incarnation: owner.incarnation,
      epoch: owner.reservationExecutionEpoch, ownerId: owner.id, sourceOwnerId: source?.id ?? null, target: resource(owner),
      source: source ? resource(source) : null, transition: command.w1Transition, quantity: command.authorizedQuantity, parent: null };
  }
}
