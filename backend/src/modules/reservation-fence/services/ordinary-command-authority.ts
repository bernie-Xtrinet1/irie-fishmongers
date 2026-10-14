import { OrdinaryReservationCommand } from '@prisma/client';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';
import { OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { OrdinaryMarkerTransaction } from '../types/ordinary-reservation-provenance.types';

// Transaction-local only: no transaction ownership, Redis or capability issuance.
export async function ordinaryCommandAuthority(context: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand, owners: OrdinaryReservationOwnerRepository, historical = false): Promise<OrdinaryDispatchIdentity> {
    const { tx, marker } = context;
    if (command.markerId !== marker.id || command.sequence === null || command.expectedSequence === null
      || command.sequence <= command.expectedSequence) throw new Error('CLAIM_SEQUENCE_REJECTED');
    if (command.effect === 'CANCEL_W1') {
      const parent = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.cancelledCommandId! } });
      if (parent.effect !== 'W1' || (!historical && parent.state !== 'REVOCATION_PENDING') || parent.ownerId !== command.ownerId
        || parent.markerId !== marker.id || parent.sequence === null || parent.sequence >= command.sequence
        || parent.queueOrdinal >= command.queueOrdinal || parent.expectedSequence !== command.expectedSequence
        || command.reason !== 'STALE_W1') throw new Error('CLAIM_PARENT_REJECTED');
      const p = await w1(context, parent, owners, false, historical);
      return { ...p, commandId: command.id, replayId: command.replayId, action: 'CANCEL_W1',
        sequence: command.sequence, expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion,
        transition: null, quantity: null, parent: JSON.stringify(p) };
    }
    return w1(context, command, owners, true, historical);
  }

async function w1({ tx, marker }: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand, owners: OrdinaryReservationOwnerRepository, current: boolean, historical: boolean): Promise<OrdinaryDispatchIdentity> {
    if (command.effect !== 'W1' || command.reason !== 'CART_INTENT' || command.authorizedQuantity === null
      || command.authorizedQuantity < 1 || command.sequence === null || command.expectedSequence === null
      || command.sequence <= command.expectedSequence || command.checkoutManifestId || command.cancelledCommandId
      || command.causeTransitionId || command.settlementReceiptHash) throw new Error('CLAIM_W1_REJECTED');
    const owner = await owners.loadAuthority(command.ownerId, tx);
    const source = command.sourceOwnerId ? await owners.loadAuthority(command.sourceOwnerId, tx) : null;
    if (owner.markerId !== marker.id || owner.generation !== command.intentGeneration || owner.cartId !== marker.cartId
      || owner.productId !== marker.productId || (!historical && (owner.checkoutManifestId || !['ISSUED', 'ACTIVE'].includes(owner.state)))
      || (source && (source.markerId !== owner.markerId || source.cartId !== owner.cartId || source.productId !== owner.productId
        || source.customerId !== owner.customerId || source.incarnation !== owner.incarnation
        || source.reservationExecutionEpoch !== owner.reservationExecutionEpoch || (!historical && source.state !== 'ACTIVE'))))
      throw new Error('CLAIM_OWNER_REJECTED');
    if (!historical && current && (marker.generation !== command.intentGeneration || marker.expectedMutationVersion !== command.expectedMutationVersion
      || marker.expectedQuantity !== command.authorizedQuantity)) throw new Error('CLAIM_STALE_INTENT');
    if (!((command.w1Transition === 'INITIAL' && !source && (historical || owner.state === 'ISSUED'))
      || (command.w1Transition === 'SAME_GENERATION' && source?.id === owner.id && (historical || owner.state === 'ACTIVE'))
      || (command.w1Transition === 'IMMEDIATE_PREDECESSOR' && source && source.generation + 1 === owner.generation && (historical || owner.state === 'ISSUED'))))
      throw new Error('CLAIM_TRANSITION_REJECTED');
    const resource = (o: typeof owner) => ({ customerId: o.customerId, cartId: o.cartId, productId: o.productId,
      markerId: o.markerId, generation: o.generation, holdInstanceId: o.holdInstanceId });
    return { version: 1, commandId: command.id, replayId: command.replayId, action: 'W1', sequence: command.sequence,
      expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion, incarnation: owner.incarnation,
      epoch: owner.reservationExecutionEpoch, ownerId: owner.id, sourceOwnerId: source?.id ?? null, target: resource(owner),
      source: source ? resource(source) : null, transition: command.w1Transition, quantity: command.authorizedQuantity, parent: null };
  }
