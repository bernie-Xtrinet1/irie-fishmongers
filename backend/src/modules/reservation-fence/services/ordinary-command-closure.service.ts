import { releaseIdentity } from '../types/ordinary-release.types';
import { requireReleasePublication } from '../repositories/ordinary-invalidation.repository';
import { createHash } from 'crypto';
import { OrdinaryReservationCommand } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryCommandPhysicalService } from './ordinary-command-physical.service';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryAcknowledgement, OrdinaryMarkerTransaction } from '../types/ordinary-reservation-provenance.types';
import { OrdinaryPhysicalIdentity } from '../types/ordinary-command-physical.types';
import { UUID_PATTERN } from '../types/reservation-fence.types';

type ClosureResult = { status: 'UNRESOLVED' } | {
  status: 'ACKNOWLEDGED'; commandId: string; completionReceiptHash: string; historical: true;
};
type Evidence = { code: string; identity: string; receipt: string; hash: string;
  envelope: Record<string, unknown>; parsed: Record<string, unknown> };

// Only successful validation below can mint this transaction-local handoff.
// It supplements durable identity/evidence validation; it is not Redis authority.
const releaseCompletions = new WeakMap<object, { context: OrdinaryMarkerTransaction; ack: OrdinaryAcknowledgement }>();
export function consumeVerifiedReleaseCompletion(context: OrdinaryMarkerTransaction, token: unknown): OrdinaryAcknowledgement {
  if (typeof token !== 'object' || token === null) throw new Error('RELEASE_VERIFIED_COMPLETION_REQUIRED');
  const proof = releaseCompletions.get(token);
  if (!proof || proof.context !== context) throw new Error('RELEASE_VERIFIED_COMPLETION_REQUIRED');
  releaseCompletions.delete(token);
  return proof.ack;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parse(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(value);
  if (!object(decoded)) throw new Error('ORDINARY_CLOSURE_EVIDENCE_REJECTED');
  return decoded;
}
function evidence(value: unknown): Evidence {
  if (!object(value) || !['COMPLETED', 'EXECUTION_WON', 'CANCELLED'].includes(String(value.code))
    || value.historical !== true || typeof value.identity !== 'string' || typeof value.receipt !== 'string')
    throw new Error('ORDINARY_CLOSURE_EVIDENCE_REJECTED');
  const envelope = parse(value.receipt);
  if (Object.keys(envelope).sort().join(',') !== 'action,complete,identity,result,version'
    || envelope.version !== 1 || envelope.complete !== true || envelope.identity !== value.identity)
    throw new Error('ORDINARY_CLOSURE_ENVELOPE_REJECTED');
  const hash = createHash('sha256').update(value.receipt).digest('hex');
  if (hash !== value.completionReceiptHash) throw new Error('ORDINARY_CLOSURE_HASH_REJECTED');
  return { code: String(value.code), identity: value.identity, receipt: value.receipt, hash,
    envelope, parsed: parse(value.identity) };
}

// Inactive Stage C. No decorator/provider, scheduler, execution, or genesis.
// Only the observation API is exposed to this service, including in tests.
export class OrdinaryCommandClosureService {
  private readonly fences: ReservationFenceRepository;
  private readonly owners: OrdinaryReservationOwnerRepository;
  private readonly commands: OrdinaryReservationCommandRepository;
  constructor(private readonly prisma: PrismaService,
    private readonly physical: Pick<OrdinaryCommandPhysicalService, 'observe'>) {
    this.fences = new ReservationFenceRepository(prisma);
    this.owners = new OrdinaryReservationOwnerRepository(prisma);
    this.commands = new OrdinaryReservationCommandRepository(prisma);
  }

  async close(commandId: string): Promise<ClosureResult> {
    if (typeof commandId !== 'string' || commandId.length !== 36 || !UUID_PATTERN.test(commandId))
      return { status: 'UNRESOLVED' };
    let observed: unknown;
    try { observed = await this.physical.observe(commandId); } catch { return this.unresolved(commandId); }
    if (object(observed) && (observed.code === 'REJECTED' || observed.code === 'UNCERTAIN'))
      return this.unresolved(commandId);
    let proof: Evidence;
    try { proof = evidence(observed); } catch { return { status: 'UNRESOLVED' }; }
    try {
      return await this.locked(commandId, async (context, requested) => {
        const winner = await this.validate(context, requested, proof);
        const ack: OrdinaryAcknowledgement = {
          commandId: winner.id, replayId: winner.replayId, sequence: winner.sequence!,
          expectedSequence: winner.expectedSequence!, completionReceiptHash: proof.hash,
        };
        let result: OrdinaryReservationCommand;
        if (winner.effect === 'RELEASE') {
          const token = Object.freeze({});
          releaseCompletions.set(token, { context, ack });
          result = await this.commands.acknowledgeVerifiedReleaseLocked(context, token);
        } else result = await this.commands.acknowledgeLocked(context, ack);
        return this.completed(result);
      });
    } catch {
      // COMMIT may have succeeded despite losing its response. Reload under the
      // same locks; return only the exact durable winner/hash, never re-execute.
      try {
        return await this.locked(commandId, async (context, requested) => {
          const winner = await this.validate(context, requested, proof);
          return winner.state === 'ACKNOWLEDGED' && winner.completionReceiptHash === proof.hash
            ? this.completed(winner) : { status: 'UNRESOLVED' };
        });
      } catch { return { status: 'UNRESOLVED' }; }
    }
  }

  async closePage(input: Parameters<OrdinaryReservationCommandRepository['discoverClosure']>[0]) {
    const page = await this.commands.discoverClosure(input);
    const results: Array<{ commandId: string; result: ClosureResult }> = [];
    // Snapshot once. No newly promoted work or same-invocation allocation.
    for (const command of page) results.push({ commandId: command.id, result: await this.close(command.id) });
    const last = page[page.length - 1];
    return { results, nextCursor: page.length === input.limit && last && last.sequence !== null
      ? { markerId: last.markerId, sequence: last.sequence, id: last.id } : null };
  }

  private locked<T>(id: string, work: (context: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand) => Promise<T>) {
    return this.fences.locked(async tx => {
      const reference = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id } });
      const context = await this.owners.lockMarker(tx, reference.markerId);
      const command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id } });
      if (!['W1', 'CANCEL_W1', 'RELEASE'].includes(command.effect)) throw new Error('ORDINARY_CLOSURE_EFFECT_REJECTED');
      return work(context, command);
    });
  }

  private async unresolved(id: string): Promise<ClosureResult> {
    try {
      return await this.locked(id, async (context, command) => {
        // A durable ACK outlives Redis evidence. This reports existing state;
        // it never accepts replacement receipt bytes or acknowledges new work.
        if (command.state === 'ACKNOWLEDGED') return this.completed(command);
        await this.commands.recordUncertaintyLocked(context, id);
        return { status: 'UNRESOLVED' };
      });
    } catch { return { status: 'UNRESOLVED' }; }
  }

  private completed(command: OrdinaryReservationCommand): ClosureResult {
    if (command.state !== 'ACKNOWLEDGED' || !command.completionReceiptHash
      || !/^[0-9a-f]{64}$/.test(command.completionReceiptHash)) throw new Error('ORDINARY_CLOSURE_ACK_REJECTED');
    return { status: 'ACKNOWLEDGED', commandId: command.id,
      completionReceiptHash: command.completionReceiptHash, historical: true };
  }

  private async identity(context: OrdinaryMarkerTransaction, command: OrdinaryReservationCommand): Promise<OrdinaryPhysicalIdentity> {
    const { tx, marker } = context;
    if (command.effect === 'RELEASE') {
      await requireReleasePublication(tx, command.id, false);
      return releaseIdentity(tx, command, this.owners);
    }
    if (command.markerId !== marker.id || command.sequence === null || command.expectedSequence === null
      || command.sequence <= command.expectedSequence) throw new Error('ORDINARY_CLOSURE_SEQUENCE_REJECTED');
    if (command.effect === 'CANCEL_W1') {
      const parent = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.cancelledCommandId! } });
      if (parent.effect !== 'W1' || parent.ownerId !== command.ownerId || parent.markerId !== marker.id
        || parent.sequence === null || parent.sequence >= command.sequence || parent.expectedSequence !== command.expectedSequence)
        throw new Error('ORDINARY_CLOSURE_PARENT_REJECTED');
      const p = await this.identity(context, parent);
      return { ...p, commandId: command.id, replayId: command.replayId, action: 'CANCEL_W1',
        sequence: command.sequence, expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion,
        transition: null, quantity: null, parent: JSON.stringify(p) };
    }
    if (command.effect !== 'W1' || command.reason !== 'CART_INTENT' || command.authorizedQuantity === null
      || command.authorizedQuantity < 1 || command.checkoutManifestId || command.cancelledCommandId
      || command.causeTransitionId || command.settlementReceiptHash) throw new Error('ORDINARY_CLOSURE_W1_REJECTED');
    const owner = await this.owners.loadAuthority(command.ownerId, tx);
    const source = command.sourceOwnerId ? await this.owners.loadAuthority(command.sourceOwnerId, tx) : null;
    if (owner.markerId !== marker.id || owner.generation !== command.intentGeneration
      || owner.cartId !== marker.cartId || owner.productId !== marker.productId
      || (source && (source.markerId !== owner.markerId || source.cartId !== owner.cartId
        || source.customerId !== owner.customerId || source.productId !== owner.productId
        || source.incarnation !== owner.incarnation || source.reservationExecutionEpoch !== owner.reservationExecutionEpoch)))
      throw new Error('ORDINARY_CLOSURE_OWNER_REJECTED');
    const transition = command.w1Transition;
    if (!((transition === 'INITIAL' && !source) || (transition === 'SAME_GENERATION' && source?.id === owner.id)
      || (transition === 'IMMEDIATE_PREDECESSOR' && source && source.generation + 1 === owner.generation)))
      throw new Error('ORDINARY_CLOSURE_TRANSITION_REJECTED');
    const resource = (o: typeof owner) => ({ customerId: o.customerId, cartId: o.cartId, productId: o.productId,
      markerId: o.markerId, generation: o.generation, holdInstanceId: o.holdInstanceId });
    return { version: 1, commandId: command.id, replayId: command.replayId, action: 'W1', sequence: command.sequence,
      expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion, incarnation: owner.incarnation,
      epoch: owner.reservationExecutionEpoch, ownerId: owner.id, sourceOwnerId: source?.id ?? null, target: resource(owner),
      source: source ? resource(source) : null, transition, quantity: command.authorizedQuantity, parent: null };
  }

  private async validate(context: OrdinaryMarkerTransaction, requested: OrdinaryReservationCommand, proof: Evidence) {
    if (typeof proof.parsed.commandId !== 'string') throw new Error('ORDINARY_CLOSURE_ID_REJECTED');
    const winner = await context.tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: proof.parsed.commandId } });
    if (proof.code === 'COMPLETED' && winner.id !== requested.id) throw new Error('ORDINARY_CLOSURE_WINNER_REJECTED');
    if (proof.code === 'EXECUTION_WON' && (requested.effect !== 'CANCEL_W1' || requested.cancelledCommandId !== winner.id))
      throw new Error('ORDINARY_CLOSURE_WINNER_REJECTED');
    if (proof.code === 'CANCELLED' && (requested.effect !== 'W1' || winner.effect !== 'CANCEL_W1' || winner.cancelledCommandId !== requested.id))
      throw new Error('ORDINARY_CLOSURE_WINNER_REJECTED');
    const expected = await this.identity(context, winner);
    if (proof.identity !== JSON.stringify(expected) || proof.envelope.action !== expected.action)
      throw new Error('ORDINARY_CLOSURE_IDENTITY_REJECTED');
    if (expected.action === 'RELEASE') {
      if (proof.envelope.result !== 'RELEASED') throw new Error('RELEASE_RESULT_REJECTED');
      const owner = await this.owners.loadAuthority(winner.ownerId, context.tx);
      if (owner.state !== (winner.state === 'ACKNOWLEDGED' ? 'CONSUMED' : 'RELEASE_PENDING'))
        throw new Error('RELEASE_LIFECYCLE_REJECTED');
    } else if (expected.action === 'CANCEL_W1') {
      if (proof.envelope.result !== 'CANCELLED') throw new Error('ORDINARY_CLOSURE_RESULT_REJECTED');
    } else {
      const e = proof.envelope.result, r = expected.target;
      if (!object(e) || e.version !== 1 || e.status !== 'ACTIVE' || e.cartId !== r.cartId || e.customerId !== r.customerId
        || e.markerId !== r.markerId || e.generation !== r.generation || e.holdInstanceId !== r.holdInstanceId
        || e.reservationExecutionEpoch !== expected.epoch || e.quantity !== expected.quantity || e.reservationMutationId !== expected.replayId
        || ['checkoutOperationId', 'checkoutAttemptId', 'checkoutIdempotencyKey'].some(key => e[key] !== null && e[key] !== undefined))
        throw new Error('ORDINARY_CLOSURE_RESULT_REJECTED');
      const { createdAt, lastRenewedAt, expiresAt, absoluteExpiresAt } = e;
      if (typeof createdAt !== 'number' || typeof lastRenewedAt !== 'number' || typeof expiresAt !== 'number' || typeof absoluteExpiresAt !== 'number'
        || ![createdAt, lastRenewedAt, expiresAt, absoluteExpiresAt].every(n => Number.isSafeInteger(n) && n >= 0)
        || createdAt > lastRenewedAt || lastRenewedAt >= expiresAt || expiresAt > absoluteExpiresAt)
        throw new Error('ORDINARY_CLOSURE_TIME_REJECTED');
    }
    if (winner.state !== 'ACKNOWLEDGED') {
      if (!['PENDING', 'UNCERTAIN', 'REVOCATION_PENDING'].includes(winner.state)
        || (winner.state === 'REVOCATION_PENDING' && winner.effect !== 'W1')) throw new Error('ORDINARY_CLOSURE_STATE_REJECTED');
      if (winner.dependsOnCommandId) {
        const dependency = await context.tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: winner.dependsOnCommandId } });
        if (!['ACKNOWLEDGED', 'CANCELLED'].includes(dependency.state)) throw new Error('ORDINARY_CLOSURE_DEPENDENCY_REJECTED');
      }
      if (winner.effect === 'W1') {
        const owner = await this.owners.loadAuthority(winner.ownerId, context.tx);
        if (owner.state !== (winner.w1Transition === 'SAME_GENERATION' ? 'ACTIVE' : 'ISSUED'))
          throw new Error('ORDINARY_CLOSURE_LIFECYCLE_REJECTED');
        if (winner.w1Transition === 'IMMEDIATE_PREDECESSOR') {
          const source = await this.owners.loadAuthority(winner.sourceOwnerId!, context.tx);
          if (source.state !== 'ACTIVE') throw new Error('ORDINARY_CLOSURE_SOURCE_STATE_REJECTED');
        }
      }
    }
    return winner;
  }
}
