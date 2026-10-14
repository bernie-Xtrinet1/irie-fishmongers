import { ordinaryCommandAuthority } from '../services/ordinary-command-authority';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { requireUnrestrictedProduct } from './product-reservation-restriction.repository';
import { releaseIdentity } from '../types/ordinary-release.types';
import { OrdinaryReservationCommandRepository } from './ordinary-reservation-command.repository';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryDispatchClaim, OrdinaryDispatchClaimResult, OrdinaryDispatchIdentity, OrdinaryPurposePlan, OrdinaryMutationCapability, OrdinaryMutationAdmission, OrdinaryMutationClaimResult } from '../types/ordinary-command-dispatch-claim.types';
import { legalPair, UUID_PATTERN } from '../types/reservation-fence.types';
import { ReservationFenceRepository } from './reservation-fence.repository';
import { OrdinaryReservationOwnerRepository } from './ordinary-reservation-owner.repository';
import { requireReleasePublication, requireOrdinaryBarrierReadiness } from './ordinary-invalidation.repository';

// INACTIVE: only for a future controlled composition in which every physical
// submission is claim-gated. Zero attempts does NOT prove arbitrary older work
// was never executed by Stage B. No historical adoption API is provided here.
// The schema has no protocol-membership discriminator: production admission of
// commands into this contract requires a separately approved boundary.
export class OrdinaryCommandDispatchClaimRepository {
  private readonly fences: ReservationFenceRepository;
  private readonly owners: OrdinaryReservationOwnerRepository;
  readonly #grants = new WeakMap<OrdinaryDispatchClaim, OrdinaryDispatchIdentity>();

  constructor(private readonly prisma: PrismaService) {
    this.fences = new ReservationFenceRepository(prisma);
    this.owners = new OrdinaryReservationOwnerRepository(prisma);
  }

  readonly #mutationGrants = new WeakMap<OrdinaryMutationCapability, { admission: OrdinaryMutationAdmission; purpose: 'GENESIS' | 'EXECUTE' }>();

  async claim(expected: OrdinaryDispatchIdentity, plan: OrdinaryPurposePlan): Promise<OrdinaryMutationClaimResult> {
    try {
      if (!['EXECUTE_ONLY', 'GENESIS_THEN_EXECUTE'].includes(plan)) return { status: 'NOT_AUTHORIZED' };
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
        const actual = await ordinaryCommandAuthority(context, command, this.owners);
        if (command.effect === 'W1') await requireUnrestrictedProduct(tx, context.marker.productId);
        await requireOrdinaryBarrierReadiness(tx, command.markerId, command.id);
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
        if (plan === 'GENESIS_THEN_EXECUTE') {
          const root = command.effect === 'CANCEL_W1'
            ? await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.cancelledCommandId! } }) : command;
          if (root.w1Transition !== 'INITIAL' || root.queueOrdinal !== 1 || root.expectedSequence !== 0
            || context.marker.ordinaryAcknowledgedSequence !== 0
            || await tx.ordinaryReservationCommand.count({ where: { markerId: command.markerId, state: 'ACKNOWLEDGED' } }))
            throw new Error('CLAIM_GENESIS_REJECTED');
        }
        return { identity: actual, dispatchTransitionId: fence.id };
      });
      // This line is reached only after confirmed outer COMMIT. Ambiguous commit
      // loses the grant permanently; reading positive attempts cannot recover it.
      const claim = Object.freeze({}) as OrdinaryMutationCapability;
      this.#mutationGrants.set(claim, { admission: identity, purpose: plan === 'GENESIS_THEN_EXECUTE' ? 'GENESIS' : 'EXECUTE' });
      return { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED', claim };
    } catch { return { status: 'NOT_AUTHORIZED' }; }
  }

  async claimRelease(admission: unknown, issuer: OrdinaryReleaseService): Promise<OrdinaryDispatchClaimResult> {
    try {
      if (!(issuer instanceof OrdinaryReleaseService)) return { status: 'NOT_AUTHORIZED' };
      const inserted = OrdinaryReleaseService.prototype.consumeAdmission.call(issuer, admission);
      if (!inserted || inserted.effect !== 'RELEASE') return { status: 'NOT_AUTHORIZED' };
      const identity = await this.fences.locked(async tx => {
        const fence = await this.fences.latest(tx), mode = await this.fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || !['OPEN', 'DRAINING'].includes(fence.phase)
          || fence.protocol !== 1 || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision
          || !legalPair(mode.mode, fence.phase, true)) throw new Error('RELEASE_FENCE_REJECTED');
        const context = await this.owners.lockMarker(tx, inserted.markerId);
        const commands = new OrdinaryReservationCommandRepository(this.prisma);
        let command = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: inserted.id } });
        if (command.replayId !== inserted.replayId || command.ownerId !== inserted.ownerId)
          throw new Error('RELEASE_ADMISSION_REJECTED');
        await requireReleasePublication(tx, command.id);
        if (command.state === 'WAITING') command = await commands.promoteLocked(context, command.id) ?? command;
        if (command.state !== 'PENDING' || command.attemptCount !== 0 || command.lastDispatchTransitionId
          || command.nextAttemptAt || command.expectedSequence !== context.marker.ordinaryAcknowledgedSequence)
          throw new Error('RELEASE_CLAIM_REJECTED');
        const actual = await releaseIdentity(tx, command, this.owners);
        if (actual.incarnation !== fence.incarnation || actual.epoch !== fence.epoch) throw new Error('RELEASE_EPOCH_REJECTED');
        const changed = await tx.ordinaryReservationCommand.updateMany({ where: { id: command.id,
          state: 'PENDING', attemptCount: 0, lastDispatchTransitionId: null },
          data: { attemptCount: 1, lastDispatchTransitionId: fence.id } });
        if (changed.count !== 1) throw new Error('RELEASE_CLAIM_LOST');
        return actual;
      });
      const claim = Object.freeze({}) as OrdinaryDispatchClaim;
      this.#grants.set(claim, identity);
      return { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED', claim };
    } catch { return { status: 'NOT_AUTHORIZED' }; }
  }

  consume(claim: OrdinaryDispatchClaim): OrdinaryDispatchIdentity | null {
    const identity = this.#grants.get(claim);
    if (!identity) return null;
    this.#grants.delete(claim);
    return structuredClone(identity);
  }

  consumeMutation(claim: OrdinaryMutationCapability, purpose: 'GENESIS' | 'EXECUTE'): OrdinaryMutationAdmission | null {
    const grant = this.#mutationGrants.get(claim);
    if (!grant) return null;
    // An authentic but misused ticket is burned, never repurposed.
    this.#mutationGrants.delete(claim);
    return grant.purpose === purpose ? structuredClone(grant.admission) : null;
  }
}
