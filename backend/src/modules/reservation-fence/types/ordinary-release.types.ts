import { OrdinaryReservationCommand, Prisma } from '@prisma/client';
import { OrdinaryPhysicalIdentity } from './ordinary-command-physical.types';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';

declare const releaseAdmissionBrand: unique symbol;
export interface OrdinaryReleaseAdmission { readonly [releaseAdmissionBrand]: true }
export interface PublicationReleaseInput {
  ownerId: string;
  reason: 'CART_REMOVAL' | 'COMPENSATION_ABSENCE' | 'RECOVERY_ABSENCE' | 'RETIREMENT';
  causeTransitionId?: string;
}

// Historical identity reconstruction is observation, never a dispatch capability.
export async function releaseIdentity(tx: Prisma.TransactionClient, command: OrdinaryReservationCommand,
  owners: OrdinaryReservationOwnerRepository): Promise<OrdinaryPhysicalIdentity> {
  if (command.effect !== 'RELEASE' || command.sequence === null || command.expectedSequence === null
    || command.sequence <= command.expectedSequence || command.sourceOwnerId || command.w1Transition
    || command.authorizedQuantity !== null || command.checkoutManifestId || command.cancelledCommandId
    || command.settlementReceiptHash) throw new Error('RELEASE_IDENTITY_REJECTED');
  const owner = await owners.loadAuthority(command.ownerId, tx);
  const parent = await tx.ordinaryReservationCommand.findFirstOrThrow({ where: {
    ownerId: owner.id, effect: 'W1', state: 'ACKNOWLEDGED', sequence: { lte: command.expectedSequence },
  }, orderBy: { sequence: 'desc' } });
  if (parent.sequence === null || parent.expectedSequence === null || parent.authorizedQuantity === null
    || !parent.completionReceiptHash || parent.intentGeneration !== owner.generation
    || parent.markerId !== command.markerId || owner.markerId !== command.markerId
    || !['INITIAL', 'SAME_GENERATION', 'IMMEDIATE_PREDECESSOR'].includes(parent.w1Transition ?? ''))
    throw new Error('RELEASE_OWNERSHIP_EVIDENCE_REQUIRED');
  const source = parent.sourceOwnerId ? await owners.loadAuthority(parent.sourceOwnerId, tx) : null;
  const resource = (o: typeof owner) => ({ customerId: o.customerId, cartId: o.cartId, productId: o.productId,
    markerId: o.markerId, generation: o.generation, holdInstanceId: o.holdInstanceId });
  const prior: OrdinaryPhysicalIdentity = { version: 1, commandId: parent.id, replayId: parent.replayId, action: 'W1',
    sequence: parent.sequence, expectedSequence: parent.expectedSequence, mutationVersion: parent.expectedMutationVersion,
    incarnation: owner.incarnation, epoch: owner.reservationExecutionEpoch, ownerId: owner.id,
    sourceOwnerId: source?.id ?? null, target: resource(owner), source: source ? resource(source) : null,
    transition: parent.w1Transition as OrdinaryPhysicalIdentity['transition'], quantity: parent.authorizedQuantity, parent: null };
  return { ...prior, commandId: command.id, replayId: command.replayId, action: 'RELEASE',
    sequence: command.sequence, expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion,
    sourceOwnerId: null, source: null, transition: null, quantity: null, parent: JSON.stringify(prior) };
}
