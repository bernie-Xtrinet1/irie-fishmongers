import { PublicationReleaseInput } from '../types/ordinary-release.types';
import { consumeVerifiedReleaseCompletion } from '../services/ordinary-command-closure.service';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryAcknowledgement, OrdinaryCommandPayload, OrdinaryMarkerTransaction, OrdinaryOwnerIssuance } from '../types/ordinary-reservation-provenance.types';
import { OrdinaryReservationOwnerRepository } from './ordinary-reservation-owner.repository';
import { requireReleasePublication, requireOrdinaryBarrierReadiness } from './ordinary-invalidation.repository';

// Persistence foundation only. No Redis, dispatcher, permit, or runtime wiring.
export class OrdinaryReservationCommandRepository {
  private readonly owners: OrdinaryReservationOwnerRepository;
  constructor(private readonly prisma: PrismaService) { this.owners = new OrdinaryReservationOwnerRepository(prisma); }

  issue(input: OrdinaryOwnerIssuance, payload: Omit<OrdinaryCommandPayload, 'ownerId' | 'effect'>) {
    return this.owners.locked(input.markerId, async context => {
      const owner = await this.owners.create(context, input);
      const command = await this.insert(context, { ...payload, ownerId: owner.id, effect: 'W1' });
      await context.tx.cartReservationSyncState.update({ where: { id: input.markerId }, data: { ordinaryProvenanceState: 'TRACKED' } });
      return { owner, command };
    });
  }

  enqueue(markerId: string, payload: OrdinaryCommandPayload) {
    return this.owners.locked(markerId, context => this.insert(context, payload));
  }

  async insert(context: OrdinaryMarkerTransaction, payload: OrdinaryCommandPayload) {
    const { tx, marker } = context;
    await requireOrdinaryBarrierReadiness(tx, marker.id);
    // FK parents outside the marker subtree must not create a backward wait.
    if (payload.checkoutManifestId) await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id=${payload.checkoutManifestId}::uuid FOR KEY SHARE NOWAIT`;
    if (payload.causeTransitionId) await tx.$queryRaw`SELECT id FROM reservation_fence_transitions WHERE id=${payload.causeTransitionId}::uuid FOR KEY SHARE NOWAIT`;
    const owner = await this.owners.loadAuthority(payload.ownerId, tx);
    if (owner.markerId !== marker.id) throw new Error('ORDINARY_MARKER_MISMATCH');
    if (payload.sourceOwnerId) {
      const source = await this.owners.loadAuthority(payload.sourceOwnerId, tx);
      if (source.markerId !== marker.id) throw new Error('ORDINARY_SOURCE_MISMATCH');
    }
    const counters = await tx.cartReservationSyncState.update({ where: { id: marker.id },
      data: { ordinaryEnqueueSequence: { increment: 1 } } });
    const command = await tx.ordinaryReservationCommand.create({ data: {
      ...payload, markerId: marker.id, queueOrdinal: counters.ordinaryEnqueueSequence,
    } });
    if (payload.effect === 'RELEASE' && owner.state !== 'RELEASE_PENDING') {
      await tx.ordinaryReservationOwner.update({ where: { id: owner.id }, data: { state: 'RELEASE_PENDING' } });
    }
    return command;
  }


  async insertPublicationRelease(tx: Prisma.TransactionClient, intentId: string, input: PublicationReleaseInput) {
    const owner = await this.owners.loadAuthority(input.ownerId, tx);
    const marker = await tx.cartReservationSyncState.findUniqueOrThrow({ where: { id: owner.markerId } });
    const scope = await tx.ordinaryInvalidationScope.findUniqueOrThrow({ where: {
      intentId_scope: { intentId, scope: `MARKER:${owner.markerId}` },
    } });
    const head = await tx.ordinaryInvalidationHead.findUniqueOrThrow({ where: { scope: scope.scope } });
    if (head.pendingIntentId !== intentId || owner.state !== 'ACTIVE') throw new Error('RELEASE_PUBLICATION_REJECTED');
    const counter = await tx.cartReservationSyncState.update({ where: { id: marker.id },
      data: { ordinaryEnqueueSequence: { increment: 1 } } });
    const command = await tx.ordinaryReservationCommand.create({ data: {
      ownerId: owner.id, markerId: marker.id, effect: 'RELEASE', reason: input.reason,
      causeTransitionId: input.causeTransitionId, intentGeneration: marker.generation,
      expectedMutationVersion: marker.expectedMutationVersion, queueOrdinal: counter.ordinaryEnqueueSequence,
    } });
    // SQL derives the binding and independently checks publicationTx and scope.
    await tx.ordinaryReservationOwner.update({ where: { id: owner.id }, data: { state: 'RELEASE_PENDING' } });
    return command;
  }

  promote(markerId: string) {
    return this.owners.locked(markerId, context => this.promoteLocked(context));
  }

  // Caller already owns marker -> ordered owners -> ordered commands locks.
  // A target filter may defer work, never bypass the existing queue selection.
  async promoteLocked(context: OrdinaryMarkerTransaction, expectedCommandId?: string) {
    const markerId = context.marker.id;
    const { tx } = context;
    const active = await tx.ordinaryReservationCommand.findFirst({ where: { markerId, state: { in: ['PENDING', 'UNCERTAIN'] } } });
    const waiting = await tx.ordinaryReservationCommand.findMany({ where: { markerId, state: 'WAITING' }, orderBy: { queueOrdinal: 'asc' } });
    // Only a cancellation tied to the occupying W1 can bypass the queue.
    const candidate = active
      ? waiting.find(c => c.effect === 'CANCEL_W1' && c.cancelledCommandId === active.id && active.effect === 'W1')
      : await this.lowestEligible(context, waiting);
    if (candidate?.effect === 'RELEASE' && await tx.ordinaryInvalidationHead.findUnique({ where: { scope: `MARKER:${markerId}` } }))
      await requireReleasePublication(tx, candidate.id);
    else await requireOrdinaryBarrierReadiness(tx, markerId);
    if (!candidate || (expectedCommandId !== undefined && candidate.id !== expectedCommandId)) return null;
    if (candidate.dependsOnCommandId) {
      const dependency = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: candidate.dependsOnCommandId } });
      if (!['ACKNOWLEDGED', 'CANCELLED'].includes(dependency.state)) return null;
    }
    await this.owners.loadAuthority(candidate.ownerId, tx);
    if (candidate.sourceOwnerId) await this.owners.loadAuthority(candidate.sourceOwnerId, tx);
    if (active) await tx.ordinaryReservationCommand.update({ where: { id: active.id }, data: { state: 'REVOCATION_PENDING' } });
    const marker = await tx.cartReservationSyncState.update({ where: { id: markerId }, data: { ordinaryCommandSequence: { increment: 1 } } });
    return tx.ordinaryReservationCommand.update({ where: { id: candidate.id }, data: {
      state: 'PENDING', sequence: marker.ordinaryCommandSequence, expectedSequence: marker.ordinaryAcknowledgedSequence,
    } });
  }

  private async lowestEligible(context: OrdinaryMarkerTransaction,
    waiting: Awaited<ReturnType<PrismaService['ordinaryReservationCommand']['findMany']>>) {
    for (const command of waiting) {
      if (command.effect === 'CANCEL_W1') continue;
      if (!command.dependsOnCommandId) return command;
      const dependency = await context.tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.dependsOnCommandId } });
      if (['ACKNOWLEDGED', 'CANCELLED'].includes(dependency.state)) return command;
    }
    return null;
  }

  recordDispatch(markerId: string, commandId: string, transitionId: string, uncertain: boolean, nextAttemptAt: Date | null) {
    return this.owners.locked(markerId, async ({ tx }) => {
      const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
      const owner = await this.owners.loadAuthority(command.ownerId, tx);
      await tx.$queryRaw`SELECT id FROM reservation_fence_transitions WHERE id=${transitionId}::uuid FOR KEY SHARE NOWAIT`;
      const transition = await tx.reservationFenceTransition.findUniqueOrThrow({ where: { id: transitionId } });
      if (command.markerId !== markerId || !['PENDING', 'UNCERTAIN'].includes(command.state)
        || transition.incarnation !== owner.incarnation || transition.epoch !== owner.reservationExecutionEpoch
        || transition.status !== 'ACKNOWLEDGED' || !['OPEN', 'DRAINING'].includes(transition.phase)
        || (command.effect === 'W1' && transition.phase !== 'OPEN')) throw new Error('ORDINARY_DISPATCH_REJECTED');
      return tx.ordinaryReservationCommand.update({ where: { id: commandId }, data: {
        state: uncertain ? 'UNCERTAIN' : 'PENDING', attemptCount: { increment: 1 }, nextAttemptAt, lastDispatchTransitionId: transitionId,
      } });
    });
  }

  acknowledge(markerId: string, evidence: OrdinaryAcknowledgement) {
    return this.owners.locked(markerId, context => this.acknowledgeLocked(context, evidence));
  }

  // Caller owns marker -> ordered owners -> ordered commands in this transaction.
  // Physical evidence verification remains the responsibility of the caller.
  async acknowledgeLocked({ tx, marker }: OrdinaryMarkerTransaction, evidence: OrdinaryAcknowledgement) {
    const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: evidence.commandId } });
    if (command.effect === 'RELEASE') throw new Error('RELEASE_VERIFIED_COMPLETION_REQUIRED');
    return this.#applyAcknowledgement({ tx, marker }, evidence);
  }

  async acknowledgeVerifiedReleaseLocked(context: OrdinaryMarkerTransaction, token: unknown) {
    const evidence = consumeVerifiedReleaseCompletion(context, token);
    const command = await context.tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: evidence.commandId } });
    if (command.effect !== 'RELEASE') throw new Error('RELEASE_VERIFIED_COMPLETION_REQUIRED');
    return this.#applyAcknowledgement(context, evidence);
  }

  async #applyAcknowledgement({ tx, marker }: OrdinaryMarkerTransaction, evidence: OrdinaryAcknowledgement) {
      const markerId = marker.id;
      const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: evidence.commandId } });
      const owner = await this.owners.loadAuthority(command.ownerId, tx);
      if (command.markerId !== markerId || command.replayId !== evidence.replayId || command.sequence !== evidence.sequence
        || command.expectedSequence !== evidence.expectedSequence || !/^[0-9a-f]{64}$/.test(evidence.completionReceiptHash))
        throw new Error('ORDINARY_ACKNOWLEDGEMENT_REJECTED');
      if (command.state === 'ACKNOWLEDGED') {
        if (command.completionReceiptHash !== evidence.completionReceiptHash) throw new Error('ORDINARY_RECEIPT_REBINDING');
        return command;
      }
      if (!['PENDING', 'UNCERTAIN', 'REVOCATION_PENDING'].includes(command.state)
        || evidence.expectedSequence !== marker.ordinaryAcknowledgedSequence
        || evidence.sequence <= marker.ordinaryAcknowledgedSequence) throw new Error('ORDINARY_ACKNOWLEDGEMENT_REJECTED');
      const now = new Date();
      const result = await tx.ordinaryReservationCommand.update({ where: { id: command.id }, data: {
        state: 'ACKNOWLEDGED', completionReceiptHash: evidence.completionReceiptHash, acknowledgedAt: now,
      } });
      await tx.cartReservationSyncState.update({ where: { id: markerId }, data: { ordinaryAcknowledgedSequence: evidence.sequence } });
      if (command.effect === 'W1') {
        if (owner.state === 'ISSUED') await tx.ordinaryReservationOwner.update({ where: { id: owner.id }, data: { state: 'ACTIVE' } });
        if (command.w1Transition === 'IMMEDIATE_PREDECESSOR' && command.sourceOwnerId) {
          await this.owners.loadAuthority(command.sourceOwnerId, tx);
          await tx.ordinaryReservationOwner.update({ where: { id: command.sourceOwnerId }, data: { state: 'SUPERSEDED', closedAt: now } });
        }
        // Execution won a cancellation race. The cancellation has no authority
        // against the new durable predecessor; retain its sequence as a gap.
        await tx.ordinaryReservationCommand.updateMany({ where: { cancelledCommandId: command.id,
          state: { in: ['WAITING', 'PENDING', 'UNCERTAIN'] } }, data: { state: 'REVOKED' } });
      } else if (command.effect === 'CANCEL_W1') {
        const parent = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.cancelledCommandId! } });
        if (parent.state !== 'REVOCATION_PENDING') throw new Error('ORDINARY_CANCELLATION_REJECTED');
        await tx.ordinaryReservationCommand.update({ where: { id: parent.id }, data: { state: 'CANCELLED' } });
      } else {
        const required = command.effect === 'RELEASE' ? 'RELEASE_PENDING' : 'TRANSFERRED';
        if (owner.state !== required) throw new Error('ORDINARY_COMPLETION_OWNER_REJECTED');
        await tx.ordinaryReservationOwner.update({ where: { id: owner.id }, data: { state: 'CONSUMED', closedAt: now } });
      }
      return result;
  }

  // Observation is not dispatch. Do not increment attempts, invent a dispatch
  // transition, or rearm work, even when the current fence is restrictive.
  async recordUncertaintyLocked({ tx, marker }: OrdinaryMarkerTransaction, commandId: string) {
    const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
    if (command.markerId !== marker.id || !['W1', 'CANCEL_W1', 'RELEASE'].includes(command.effect))
      throw new Error('ORDINARY_CLOSURE_COMMAND_REJECTED');
    if (command.state !== 'PENDING') return command;
    return tx.ordinaryReservationCommand.update({ where: { id: command.id }, data: { state: 'UNCERTAIN' } });
  }

  discoverClosure(input: { limit: number; cursor?: { markerId: string; sequence: number; id: string } }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error('ORDINARY_CLOSURE_PAGE_REJECTED');
    const cursor = input.cursor;
    if (cursor && (!cursor.markerId || !cursor.id || !Number.isInteger(cursor.sequence) || cursor.sequence < 1))
      throw new Error('ORDINARY_CLOSURE_CURSOR_REJECTED');
    return this.prisma.ordinaryReservationCommand.findMany({ where: { AND: [
      { effect: { in: ['W1', 'CANCEL_W1', 'RELEASE'] }, sequence: { not: null } },
      { OR: [{ state: { in: ['PENDING', 'UNCERTAIN'] } }, { effect: 'W1', state: 'REVOCATION_PENDING' }] },
      ...(cursor ? [{ OR: [
        { markerId: { gt: cursor.markerId } },
        { markerId: cursor.markerId, sequence: { gt: cursor.sequence } },
        { markerId: cursor.markerId, sequence: cursor.sequence, id: { gt: cursor.id } },
      ] }] : []),
    ] }, orderBy: [{ markerId: 'asc' }, { sequence: 'asc' }, { id: 'asc' }], take: input.limit });
  }

  pending(markerId: string) {
    return this.prisma.ordinaryReservationCommand.findMany({ where: { markerId, state: {
      in: ['WAITING', 'PENDING', 'UNCERTAIN', 'REVOCATION_PENDING'],
    } }, orderBy: { queueOrdinal: 'asc' } });
  }
}
