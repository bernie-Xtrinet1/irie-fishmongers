import { createHash, randomUUID } from 'crypto';
import { OrdinaryReservationCommand, OrdinaryReservationOwner } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { OrdinaryReservationOwnerRepository } from '../repositories/ordinary-reservation-owner.repository';
import { legalPair, UUID_PATTERN } from '../types/reservation-fence.types';
import { ResourceAuthority } from '../types/reservation-mutation.types';
import { OrdinaryPhysicalGrant, OrdinaryPhysicalIdentity, OrdinaryPhysicalResult,
  ordinaryPhysicalGrantKey, ordinaryPhysicalLedgerKey } from '../types/ordinary-command-physical.types';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY } from '../lua/reservation-mutation-common.lua';
import { ORDINARY_PHYSICAL_REGISTER, ORDINARY_PHYSICAL_GENESIS, ORDINARY_PHYSICAL_EXECUTE,
  ORDINARY_PHYSICAL_OBSERVE } from '../lua/ordinary-command-physical.lua';

// No Injectable decorator, module registration, or caller. Stage B never writes
// PostgreSQL and never invokes issuance, dispatch scheduling, or acknowledgement.
export class OrdinaryCommandPhysicalService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  initialize(commandId: string): Promise<OrdinaryPhysicalResult> { return this.run(commandId, 'GENESIS'); }
  execute(commandId: string): Promise<OrdinaryPhysicalResult> { return this.run(commandId, 'EXECUTE'); }
  observe(commandId: string): Promise<OrdinaryPhysicalResult> { return this.run(commandId, 'OBSERVE'); }

  private async load(commandId: string, purpose: 'GENESIS' | 'EXECUTE' | 'OBSERVE') {
    if (typeof commandId !== 'string' || commandId.length !== 36 || !UUID_PATTERN.test(commandId)) throw new Error('Invalid command');
    const fences = new ReservationFenceRepository(this.prisma);
    const owners = new OrdinaryReservationOwnerRepository(this.prisma);
    return fences.locked(async tx => {
      const fence = await fences.latest(tx), mode = await fences.mode(tx);
      if (!fence) throw new Error('Missing fence');
      if (purpose !== 'OBSERVE' && (fence.status !== 'ACKNOWLEDGED' || fence.phase !== 'OPEN'
        || fence.protocol !== 1 || fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision
        || !legalPair(mode.mode, fence.phase, true))) throw new Error('Fence denied');
      // Read the immutable marker association before acquiring its subtree.
      const reference = await tx.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: commandId } });
      const { marker } = await owners.lockMarker(tx, reference.markerId);
      const rows = await tx.ordinaryReservationCommand.findMany({ where: { markerId: marker.id }, orderBy: { queueOrdinal: 'asc' } });
      const command = rows.find(row => row.id === commandId);
      if (!command || (purpose !== 'OBSERVE' && command.state !== 'PENDING')) throw new Error('Command denied');
      const resource = (o: OrdinaryReservationOwner): ResourceAuthority => ({ customerId: o.customerId, cartId: o.cartId,
        productId: o.productId, markerId: o.markerId, generation: o.generation, holdInstanceId: o.holdInstanceId });
      const identity = async (c: OrdinaryReservationCommand): Promise<OrdinaryPhysicalIdentity> => {
        if (c.effect !== 'W1' || c.sequence === null || c.expectedSequence === null || c.sequence <= c.expectedSequence
          || c.reason !== 'CART_INTENT' || c.checkoutManifestId || c.cancelledCommandId || c.causeTransitionId
          || c.settlementReceiptHash || c.authorizedQuantity === null) throw new Error('Invalid W1');
        const o = await owners.loadAuthority(c.ownerId, tx);
        const s = c.sourceOwnerId ? await owners.loadAuthority(c.sourceOwnerId, tx) : null;
        if (o.markerId !== marker.id || o.generation !== c.intentGeneration || o.cartId !== marker.cartId || o.productId !== marker.productId)
          throw new Error('Owner mismatch');
        if (s && (s.markerId !== o.markerId || s.cartId !== o.cartId || s.customerId !== o.customerId || s.productId !== o.productId
          || s.incarnation !== o.incarnation || s.reservationExecutionEpoch !== o.reservationExecutionEpoch)) throw new Error('Source mismatch');
        if (c.w1Transition === 'INITIAL') { if (s) throw new Error('Unexpected source'); }
        else if (c.w1Transition === 'SAME_GENERATION') { if (!s || s.id !== o.id) throw new Error('Same-generation mismatch'); }
        else if (c.w1Transition === 'IMMEDIATE_PREDECESSOR') {
          if (!s || s.generation + 1 !== o.generation) throw new Error('Predecessor mismatch');
        } else throw new Error('Unsupported transition');
        if (purpose !== 'OBSERVE') {
          if (o.incarnation !== fence.incarnation || o.reservationExecutionEpoch !== fence.epoch) throw new Error('Epoch mismatch');
          if (command.effect === 'W1') {
            if (!['ISSUED', 'ACTIVE'].includes(o.state) || (s && s.state !== 'ACTIVE') || o.checkoutManifestId
              || marker.generation !== c.intentGeneration || marker.expectedMutationVersion !== c.expectedMutationVersion
              || marker.expectedQuantity !== c.authorizedQuantity) throw new Error('Stale intent');
          }
        }
        return { version: 1, commandId: c.id, replayId: c.replayId, action: 'W1', sequence: c.sequence,
          expectedSequence: c.expectedSequence, mutationVersion: c.expectedMutationVersion, incarnation: o.incarnation,
          epoch: o.reservationExecutionEpoch, ownerId: o.id, sourceOwnerId: s?.id ?? null, target: resource(o),
          source: s ? resource(s) : null, transition: c.w1Transition, quantity: c.authorizedQuantity, parent: null };
      };
      let root = command;
      let result: OrdinaryPhysicalIdentity;
      if (command.effect === 'CANCEL_W1') {
        const parent = rows.find(row => row.id === command.cancelledCommandId);
        if (!parent || parent.ownerId !== command.ownerId || command.sequence === null || command.expectedSequence === null
          || command.sequence <= parent.sequence! || command.expectedSequence !== parent.expectedSequence
          || (purpose !== 'OBSERVE' && parent.state !== 'REVOCATION_PENDING')) throw new Error('Cancellation denied');
        const p = await identity(parent);
        root = parent;
        result = { ...p, commandId: command.id, replayId: command.replayId, action: 'CANCEL_W1',
          sequence: command.sequence, expectedSequence: command.expectedSequence, mutationVersion: command.expectedMutationVersion,
          transition: null, quantity: null, parent: JSON.stringify(p) };
      } else result = await identity(command);
      if (purpose === 'GENESIS' && (root.w1Transition !== 'INITIAL' || root.queueOrdinal !== 1 || root.expectedSequence !== 0
        || marker.ordinaryAcknowledgedSequence !== 0 || rows.some(row => row.state === 'ACKNOWLEDGED')))
        throw new Error('Genesis denied');
      return { identity: JSON.stringify(result), tuple: transitionTuple(fence), markerId: marker.id };
    });
  }

  private async run(commandId: string, purpose: 'GENESIS' | 'EXECUTE' | 'OBSERVE'): Promise<OrdinaryPhysicalResult> {
    let authority: Awaited<ReturnType<OrdinaryCommandPhysicalService['load']>>;
    try { authority = await this.load(commandId, purpose); } catch { return { code: 'REJECTED' }; }
    // load() has fully committed before the first Redis operation.
    try {
      const ledger = ordinaryPhysicalLedgerKey(authority.markerId);
      if (purpose === 'OBSERVE') return this.decode(await this.redis.eval(ORDINARY_PHYSICAL_OBSERVE,
        [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, ledger], [authority.identity]), authority.identity);
      const grant: OrdinaryPhysicalGrant = { version: 1, grantId: randomUUID(), tuple: authority.tuple,
        identity: authority.identity, purpose, expiresAt: 0 };
      const keys = [RESERVATION_FENCE_KEY, MUTATION_HISTORY_KEY, ledger, ordinaryPhysicalGrantKey(grant.grantId)];
      const raw = await this.redis.eval(ORDINARY_PHYSICAL_REGISTER, keys, [JSON.stringify(grant)]);
      if (typeof raw !== 'string') return { code: 'UNCERTAIN' };
      const registered: unknown = JSON.parse(raw);
      if (!registered || typeof registered !== 'object' || !('code' in registered)) return { code: 'UNCERTAIN' };
      if (registered.code === 'REJECTED') return { code: 'REJECTED' };
      if (registered.code !== 'REGISTERED') return { code: 'UNCERTAIN' };
      return this.decode(await this.redis.eval(purpose === 'GENESIS' ? ORDINARY_PHYSICAL_GENESIS : ORDINARY_PHYSICAL_EXECUTE,
        keys, [JSON.stringify(grant)]), authority.identity, purpose === 'GENESIS');
    } catch { return { code: 'UNCERTAIN' }; }
  }

  private decode(raw: unknown, expectedIdentity: string, genesis = false): OrdinaryPhysicalResult {
    if (typeof raw !== 'string') return { code: 'UNCERTAIN' };
    const result: unknown = JSON.parse(raw);
    if (!result || typeof result !== 'object' || !('code' in result)) return { code: 'UNCERTAIN' };
    if (result.code === 'REJECTED') return { code: 'REJECTED' };
    if (result.code === 'INITIALIZED') return genesis ? { code: 'INITIALIZED' } : { code: 'UNCERTAIN' };
    if ((result.code === 'COMPLETED' || result.code === 'EXECUTION_WON' || result.code === 'CANCELLED')
      && 'receipt' in result && typeof result.receipt === 'string' && 'identity' in result && typeof result.identity === 'string') {
      const receipt: unknown = JSON.parse(result.receipt);
      if (!receipt || typeof receipt !== 'object' || !('identity' in receipt) || receipt.identity !== result.identity
        || !('version' in receipt) || receipt.version !== 1 || !('complete' in receipt) || receipt.complete !== true)
        return { code: 'UNCERTAIN' };
      const requested = JSON.parse(expectedIdentity) as OrdinaryPhysicalIdentity;
      const completed = JSON.parse(result.identity) as OrdinaryPhysicalIdentity;
      if (result.code === 'COMPLETED' && result.identity !== expectedIdentity) return { code: 'UNCERTAIN' };
      if (result.code === 'EXECUTION_WON' && (requested.action !== 'CANCEL_W1' || requested.parent !== result.identity))
        return { code: 'UNCERTAIN' };
      if (result.code === 'CANCELLED' && (completed.action !== 'CANCEL_W1' || completed.parent !== expectedIdentity))
        return { code: 'UNCERTAIN' };
      return { code: result.code, historical: true, receipt: result.receipt, identity: result.identity,
        completionReceiptHash: createHash('sha256').update(result.receipt).digest('hex') };
    }
    return { code: 'UNCERTAIN' };
  }
}
