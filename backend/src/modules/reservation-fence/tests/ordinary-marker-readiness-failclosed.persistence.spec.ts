import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import {
  assertOrdinaryBarrierReadiness,
  requireOrdinaryCommandBinding,
  requireOrdinaryBarrierReadiness,
} from '../repositories/ordinary-invalidation.repository';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { barrierAcknowledgement, InvalidationRequest } from '../types/ordinary-invalidation.types';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';

describe('Ordinary marker fail-closed barrier readiness and command binding', () => {
  jest.setTimeout(120000);

  async function isolated(work: (db: PrismaService, schema: Awaited<ReturnType<typeof openOrdinarySchema>>) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      await work(schema.db, schema);
    } finally {
      await schema.close();
    }
  }

  async function setupReadyPair(db: PrismaService) {
    const f = await ordinaryFixture(db);
    const tuple = transitionTuple(f.transition);
    const repo = new OrdinaryInvalidationRepository(db);
    const publication = new OrdinaryInvalidationPublicationService(repo);

    await db.ordinaryInvalidationHead.createMany({
      data: ['GLOBAL', `MARKER:${f.marker.id}`].map(scope => ({
        scope,
        incarnation: tuple.incarnation,
        epoch: tuple.epoch,
      })),
    });

    const markerScope = {
      kind: 'MARKER' as const,
      revision: 0,
      markerId: f.marker.id,
      cartId: f.cartId,
      productId: f.productId,
      customerId: f.customerId,
      before: { generation: 0, mutationVersion: 0, quantity: 2 },
      after: { generation: 0, mutationVersion: 0, quantity: 2 },
      cartBefore: null,
      cartAfter: null,
      ownersBefore: [],
      ownersAfter: [],
    };

    const initial: InvalidationRequest = {
      version: 1,
      intentId: randomUUID(),
      operationId: randomUUID(),
      kind: 'CART',
      incarnation: tuple.incarnation,
      epoch: tuple.epoch,
      scopes: [
        {
          kind: 'GLOBAL',
          revision: 0,
          before: tuple,
          after: tuple,
          modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
          modeAfter: null,
        },
        markerScope,
      ],
    };

    await repo.prepare(initial);
    await repo.confirm(initial, barrierAcknowledgement(initial));
    await publication.publish(initial.intentId, () => Promise.resolve({ bootstrap: true }));
    await db.ordinaryInvalidationHead.updateMany({ data: { ready: true } });

    return { ...f, tuple, repo, publication, initial };
  }

  describe('assertOrdinaryBarrierReadiness', () => {
    it('throws ORDINARY_MARKER_NOT_ENROLLED when marker head does not exist', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('ORDINARY_MARKER_NOT_ENROLLED');
    }));

    it('throws ORDINARY_MARKER_NOT_READY when marker head is ready: false', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.transition.incarnation,
          epoch: f.transition.epoch,
        },
      });

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('ORDINARY_MARKER_NOT_READY');
    }));

    it('throws GLOBAL_INVALIDATION_NOT_READY when global head does not exist', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: `MARKER:${f.marker.id}`,
          incarnation: f.transition.incarnation,
          epoch: f.transition.epoch,
          ready: true,
        },
      });

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('GLOBAL_INVALIDATION_NOT_READY');
    }));

    it('throws GLOBAL_INVALIDATION_NOT_READY when global head is ready: false', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.$executeRawUnsafe(`UPDATE ordinary_invalidation_heads SET ready = false WHERE scope = 'GLOBAL'`);

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('GLOBAL_INVALIDATION_NOT_READY');
    }));

    it('throws INVALIDATION_PENDING when global head has pendingIntentId', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const pendingIntent: InvalidationRequest = {
        version: 1,
        intentId: randomUUID(),
        operationId: randomUUID(),
        kind: 'FENCE',
        incarnation: f.tuple.incarnation,
        epoch: f.tuple.epoch,
        scopes: [
          {
            kind: 'GLOBAL',
            revision: 1,
            before: f.tuple,
            after: f.tuple,
            modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
            modeAfter: null,
          },
        ],
      };
      await f.repo.prepare(pendingIntent);

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('INVALIDATION_PENDING');
    }));

    it('throws ORDINARY_INCARNATION_MISMATCH when global and marker incarnation differ', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.$executeRawUnsafe(`UPDATE ordinary_invalidation_heads SET incarnation = '${randomUUID()}' WHERE scope = 'GLOBAL'`);

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('ORDINARY_INCARNATION_MISMATCH');
    }));

    it('throws ORDINARY_EPOCH_MISMATCH when global and marker epoch differ', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.$executeRawUnsafe(`UPDATE ordinary_invalidation_heads SET epoch = 999 WHERE scope = 'GLOBAL'`);

      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('ORDINARY_EPOCH_MISMATCH');
    }));

    it('succeeds (void) when marker and global heads are both ready and aligned', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await expect(
        db.$transaction(tx => assertOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).resolves.toBeUndefined();
    }));
  });

  describe('requireOrdinaryCommandBinding', () => {
    it('returns genuine persisted binding when command binding matches published revisions', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      const binding = await db.$transaction(tx =>
        requireOrdinaryCommandBinding(tx, f.marker.id, issued.command.id),
      );

      expect(binding).toMatchObject({
        commandId: issued.command.id,
        replayId: issued.command.replayId,
        markerId: f.marker.id,
        version: 1,
        globalRevision: 1,
        markerRevision: 1,
        incarnation: f.transition.incarnation,
        epoch: f.transition.epoch,
      });
    }));

    it('throws INVALIDATION_BINDING_REJECTED when binding row is missing', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const fakeCommandId = randomUUID();

      await expect(
        db.$transaction(tx => requireOrdinaryCommandBinding(tx, f.marker.id, fakeCommandId)),
      ).rejects.toThrow('INVALIDATION_BINDING_REJECTED');
    }));

    it('throws INVALIDATION_BINDING_REJECTED when binding globalRevision does not match publishedRevision', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_binding_immutable ON ordinary_command_barrier_bindings`);
      await db.$executeRawUnsafe(`UPDATE ordinary_command_barrier_bindings SET "globalRevision" = 999 WHERE "commandId" = '${issued.command.id}'`);

      await expect(
        db.$transaction(tx => requireOrdinaryCommandBinding(tx, f.marker.id, issued.command.id)),
      ).rejects.toThrow('INVALIDATION_BINDING_REJECTED');
    }));

    it('throws INVALIDATION_BINDING_REJECTED when binding markerRevision does not match publishedRevision', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_binding_immutable ON ordinary_command_barrier_bindings`);
      await db.$executeRawUnsafe(`UPDATE ordinary_command_barrier_bindings SET "markerRevision" = 999 WHERE "commandId" = '${issued.command.id}'`);

      await expect(
        db.$transaction(tx => requireOrdinaryCommandBinding(tx, f.marker.id, issued.command.id)),
      ).rejects.toThrow('INVALIDATION_BINDING_REJECTED');
    }));

    it('throws INVALIDATION_BINDING_REJECTED when binding epoch does not match head epoch', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_binding_immutable ON ordinary_command_barrier_bindings`);
      await db.$executeRawUnsafe(`UPDATE ordinary_command_barrier_bindings SET epoch = 999 WHERE "commandId" = '${issued.command.id}'`);

      await expect(
        db.$transaction(tx => requireOrdinaryCommandBinding(tx, f.marker.id, issued.command.id)),
      ).rejects.toThrow('INVALIDATION_BINDING_REJECTED');
    }));

    it('throws INVALIDATION_BINDING_REJECTED when binding markerId does not match', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      await expect(
        db.$transaction(tx => requireOrdinaryCommandBinding(tx, randomUUID(), issued.command.id)),
      ).rejects.toThrow();
    }));
  });

  describe('requireOrdinaryBarrierReadiness (shared helper backward compatibility)', () => {
    it('returns null for unenrolled markers when called without commandId (legacy mode)', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      const result = await db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, f.marker.id));
      expect(result).toBeNull();
    }));

    it('returns null for unenrolled markers when called with commandId (legacy mode)', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      const issued = await f.commands.issue(f.issuance, f.payload);
      const result = await db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, f.marker.id, issued.command.id));
      expect(result).toBeNull();
    }));

    it('returns genuine binding for enrolled and bound command', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const issued = await f.commands.issue(f.issuance, f.payload);

      const binding = await db.$transaction(tx =>
        requireOrdinaryBarrierReadiness(tx, f.marker.id, issued.command.id),
      );

      expect(binding).toMatchObject({
        commandId: issued.command.id,
        markerId: f.marker.id,
        version: 1,
        globalRevision: 1,
        markerRevision: 1,
      });
    }));

    it('throws for enrolled marker when binding is missing', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await expect(
        db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, f.marker.id, randomUUID())),
      ).rejects.toThrow('INVALIDATION_BINDING_REJECTED');
    }));

    it('throws ORDINARY_MARKER_NOT_ENROLLED when global head exists but marker is unenrolled', () => isolated(async db => {
      await setupReadyPair(db);
      const unenrolledMarkerId = randomUUID();
      await expect(
        db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, unenrolledMarkerId)),
      ).rejects.toThrow('ORDINARY_MARKER_NOT_ENROLLED');
    }));

    it('throws GLOBAL_INVALIDATION_NOT_READY when global head is unready', () => isolated(async db => {
      const f = await setupReadyPair(db);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.$executeRawUnsafe(`UPDATE ordinary_invalidation_heads SET ready = false WHERE scope = 'GLOBAL'`);

      await expect(
        db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('GLOBAL_INVALIDATION_NOT_READY');
    }));

    it('throws INVALIDATION_PENDING when global head has pending invalidation', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const pendingIntent: InvalidationRequest = {
        version: 1,
        intentId: randomUUID(),
        operationId: randomUUID(),
        kind: 'FENCE',
        incarnation: f.tuple.incarnation,
        epoch: f.tuple.epoch,
        scopes: [
          {
            kind: 'GLOBAL',
            revision: 1,
            before: f.tuple,
            after: f.tuple,
            modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision },
            modeAfter: null,
          },
        ],
      };
      await f.repo.prepare(pendingIntent);

      await expect(
        db.$transaction(tx => requireOrdinaryBarrierReadiness(tx, f.marker.id)),
      ).rejects.toThrow('INVALIDATION_PENDING');
    }));

    it('claim() rejects on unenrolled marker under active global head and preserves attemptCount = 0', () => isolated(async db => {
      const f = await ordinaryFixture(db);
      const issued = await f.commands.issue(f.issuance, f.payload);
      const command = await f.commands.promote(f.marker.id);
      if (!command) throw new Error('Missing command');

      const tuple = transitionTuple(f.transition);
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS invalidation_head_guard ON ordinary_invalidation_heads`);
      await db.ordinaryInvalidationHead.create({
        data: {
          scope: 'GLOBAL',
          incarnation: tuple.incarnation,
          epoch: tuple.epoch,
          ready: true,
        },
      });

      const identity = {
        version: 1 as const,
        commandId: command.id,
        replayId: command.replayId,
        action: 'W1' as const,
        sequence: command.sequence!,
        expectedSequence: command.expectedSequence!,
        mutationVersion: 0,
        incarnation: issued.owner.incarnation,
        epoch: 1,
        ownerId: issued.owner.id,
        sourceOwnerId: null,
        target: {
          customerId: f.customerId,
          cartId: f.cartId,
          productId: f.productId,
          markerId: f.marker.id,
          generation: 0,
          holdInstanceId: issued.owner.holdInstanceId,
        },
        source: null,
        transition: 'INITIAL' as const,
        quantity: 2,
        parent: null,
      };

      const claimsRepo = new OrdinaryCommandDispatchClaimRepository(db);
      const claimResult = await claimsRepo.claim(identity, 'EXECUTE_ONLY');
      expect(claimResult.status).toBe('NOT_AUTHORIZED');

      const freshCommand = await db.ordinaryReservationCommand.findUniqueOrThrow({ where: { id: command.id } });
      expect(freshCommand.attemptCount).toBe(0);
      expect(freshCommand.lastDispatchTransitionId).toBeNull();
    }));

    it('W1 issuance rejects on unenrolled marker under active global head and creates no command or owner', () => isolated(async db => {
      const f = await setupReadyPair(db);
      const existingProduct = await db.product.findUniqueOrThrow({ where: { id: f.productId } });
      const product2 = await db.product.create({
        data: {
          id: randomUUID(),
          vendorId: existingProduct.vendorId,
          categoryId: existingProduct.categoryId,
          name: 'Unenrolled Snapper Issue',
          description: 'Second product description',
          unit: existingProduct.unit,
          price: 900,
          quantityAvailable: 10,
          imageUrl: 'https://cdn.example.com/snapper3.jpg',
        },
      });
      const unenrolledMarker = await db.cartReservationSyncState.create({
        data: {
          id: randomUUID(),
          cartId: f.cartId,
          productId: product2.id,
          expectedQuantity: 2,
          expectedMutationVersion: 0,
          ordinaryProvenanceState: 'NEW',
        },
      });

      await expect(
        f.commands.issue({ ...f.issuance, markerId: unenrolledMarker.id, productId: product2.id }, f.payload),
      ).rejects.toThrow('ORDINARY_MARKER_NOT_ENROLLED');

      const commandCount = await db.ordinaryReservationCommand.count({ where: { markerId: unenrolledMarker.id } });
      const ownerCount = await db.ordinaryReservationOwner.count({ where: { markerId: unenrolledMarker.id } });
      expect(commandCount).toBe(0);
      expect(ownerCount).toBe(0);
    }));
  });
});
