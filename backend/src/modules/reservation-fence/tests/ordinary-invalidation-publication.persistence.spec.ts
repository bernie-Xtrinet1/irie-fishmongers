import { randomUUID } from 'crypto';
import { openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';
import { OrdinaryInvalidationRepository } from '../repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { barrierAcknowledgement, InvalidationRequest } from '../types/ordinary-invalidation.types';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CartMutationBarrierConfigRepository } from '../../cart-mutation-barrier/repositories/cart-mutation-barrier-config.repository';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { seedCartAndProduct, setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';

describe('inactive transaction-bound invalidation publication', () => {
  jest.setTimeout(120000);
  async function fixture(work: (f: Awaited<ReturnType<typeof ordinaryFixture>>, request: InvalidationRequest,
    repo: OrdinaryInvalidationRepository, publication: OrdinaryInvalidationPublicationService) => Promise<void>) {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryFixture(schema.db);
      await f.db.cartItem.create({ data: { cartId: f.cartId, productId: f.productId, quantity: 2 } });
      await f.db.ordinaryInvalidationHead.createMany({ data: ['GLOBAL', `MARKER:${f.marker.id}`].map(scope => ({
        scope, incarnation: f.transition.incarnation, epoch: 1 })) });
      const item = await f.db.cartItem.findUniqueOrThrow({ where: { cartId_productId: { cartId: f.cartId, productId: f.productId } } });
      const request: InvalidationRequest = { version: 1, intentId: randomUUID(), operationId: randomUUID(), kind: 'CART',
        incarnation: f.transition.incarnation, epoch: 1, scopes: [{ kind: 'MARKER', markerId: f.marker.id,
          customerId: f.customerId, cartId: f.cartId, productId: f.productId, revision: 0,
          before: { generation: 0, mutationVersion: 0, quantity: 2 },
          after: { generation: 1, mutationVersion: item.mutationVersion + 1, quantity: 3 },
          cartBefore: { id: item.id, mutationVersion: item.mutationVersion, quantity: item.quantity },
          cartAfter: { id: item.id, mutationVersion: item.mutationVersion + 1, quantity: 3 }, ownersBefore: [], ownersAfter: [] }] };
      const repo = new OrdinaryInvalidationRepository(f.db);
      await repo.prepare(request);
      // Structural PG evidence only; real Redis confirmation is tested separately.
      await repo.confirm(request, barrierAcknowledgement(request));
      await work(f, request, repo, new OrdinaryInvalidationPublicationService(repo));
    } finally { await schema.close(); }
  }
  it.each(['cart', 'product', 'both', 'enrolled destination', 'incoming'] as const)('direct identity rewrite rejects %s with unchanged quantity/version', kind => fixture(async f => {
    const other = await seedCartAndProduct(await setUpCompensationFixture(f.db));
    const target = { cartId: kind === 'product' ? f.cartId : other.cartId,
      productId: kind === 'cart' ? f.productId : other.productId };
    if (kind === 'enrolled destination') {
      const marker = await f.db.cartReservationSyncState.create({ data: { ...target, expectedQuantity: 2,
        expectedMutationVersion: 0, ordinaryProvenanceState: 'NEW' } });
      await f.db.ordinaryInvalidationHead.create({ data: { scope: `MARKER:${marker.id}`, incarnation: f.transition.incarnation, epoch: 1 } });
    }
    const original = await f.db.cartItem.findUniqueOrThrow({ where: { cartId_productId: { cartId: f.cartId, productId: f.productId } } });
    const item = kind === 'incoming' ? await f.db.cartItem.create({ data: { ...target, quantity: 2 } }) : original;
    const destination = kind === 'incoming' ? { cartId: f.cartId, productId: f.productId } : target;
    await expect(f.db.$executeRaw`UPDATE cart_items SET "cartId"=${destination.cartId}, "productId"=${destination.productId} WHERE id=${item.id}`)
      .rejects.toThrow('enrolled cart identity immutable');
    expect(await f.db.cartItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(item);
  }));
  it('direct enrolled marker identity rewrite checks OLD before NEW enrollment', () => fixture(async f => {
    const replacement = randomUUID();
    await expect(f.db.$executeRaw`UPDATE cart_reservation_sync_states SET id=${replacement} WHERE id=${f.marker.id}`)
      .rejects.toThrow('enrolled marker identity immutable');
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toEqual(f.marker);
    expect(await f.db.cartReservationSyncState.findUnique({ where: { id: replacement } })).toBeNull();
  }));
  it('genuinely unenrolled historical identity rewrites retain compatibility without enrollment', () => fixture(async f => {
    const seed = await setUpCompensationFixture(f.db), from = await seedCartAndProduct(seed), to = await seedCartAndProduct(seed);
    const item = await f.db.cartItem.create({ data: { cartId: from.cartId, productId: from.productId, quantity: 2 } });
    const marker = await f.db.cartReservationSyncState.create({ data: { cartId: from.cartId, productId: from.productId,
      expectedQuantity: 2, expectedMutationVersion: 0 } });
    await f.db.$executeRaw`UPDATE cart_items SET "cartId"=${to.cartId}, "productId"=${to.productId} WHERE id=${item.id}`;
    const id = randomUUID();
    await f.db.$executeRaw`UPDATE cart_reservation_sync_states SET id=${id} WHERE id=${marker.id}`;
    expect(await f.db.cartItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ cartId: to.cartId, productId: to.productId, quantity: 2, mutationVersion: item.mutationVersion });
    expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id } })).toMatchObject({ ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED' });
    expect(await f.db.ordinaryInvalidationHead.findUnique({ where: { scope: `MARKER:${id}` } })).toBeNull();
  }));
  it.each(['UPDATE', 'DELETE'] as const)('direct %s of enrolled mode history fails closed', action => fixture(async f => {
    const before = await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } });
    if (action === 'UPDATE') await expect(f.db.$executeRaw`UPDATE reservation_engine_mode_configs SET mode='DRAINING' WHERE revision=${f.transition.modeRevision}`)
      .rejects.toThrow('enrolled mode history append-only');
    else await expect(f.db.$executeRaw`DELETE FROM reservation_engine_mode_configs WHERE revision=${f.transition.modeRevision}`)
      .rejects.toThrow('enrolled mode history append-only');
    expect(await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } })).toEqual(before);
  }));
  it.each(['temp', 'search_path'] as const)('%s shadow cannot hide mode, cart, marker or TRUNCATE enrollment', shadow => fixture(async f => {
    const [row] = await f.db.$queryRaw<{ schema: string }[]>`SELECT current_schema() AS schema`;
    if (!row || !/^ordinary_test_[a-f0-9]{32}$/.test(row.schema)) throw new Error('Unexpected fixture schema');
    const application = `"${row.schema}"`;
    const attacker = `"shadow_${randomUUID().replace(/-/g, '')}"`;
    const item = await f.db.cartItem.findUniqueOrThrow({ where: { cartId_productId: { cartId: f.cartId, productId: f.productId } } });
    const modes = await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } });
    for (const target of ['mode', 'cart', 'marker', 'truncate'] as const) {
      const expected = target === 'mode' ? 'enrolled mode history append-only'
        : target === 'truncate' ? 'enrolled mode history cannot be truncated' : 'enrolled publication requires exact confirmed intent';
      await expect(f.db.$transaction(async tx => {
        // DDL and the protected write use the same connection. Expected failure
        // rolls back every test-owned shadow object and SET LOCAL change.
        if (shadow === 'temp') await tx.$executeRaw`CREATE TEMP TABLE ordinary_invalidation_heads (scope text)`;
        else {
          await tx.$executeRawUnsafe(`CREATE SCHEMA ${attacker}`);
          await tx.$executeRawUnsafe(`CREATE TABLE ${attacker}.ordinary_invalidation_heads (scope text)`);
          await tx.$executeRawUnsafe(`CREATE FUNCTION ${attacker}.ordinary_invalidation_publication_scope(text) RETURNS jsonb LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_FUNCTION_CALLED'; END $body$`);
          await tx.$queryRaw`SELECT set_config('search_path', ${`${attacker}, ${application}, pg_catalog, pg_temp`}, true)`;
        }
        // Qualified target tables prevent the test itself from hitting shadows.
        // Identifiers above are generated/validated fixture identifiers only;
        // all row values remain query parameters.
        if (target === 'mode') await tx.$executeRawUnsafe(`UPDATE ${application}.reservation_engine_mode_configs SET mode='DRAINING' WHERE revision=$1`, f.transition.modeRevision);
        if (target === 'cart') await tx.$executeRawUnsafe(`UPDATE ${application}.cart_items SET quantity=3 WHERE id=$1`, item.id);
        if (target === 'marker') await tx.$executeRawUnsafe(`UPDATE ${application}.cart_reservation_sync_states SET generation=1 WHERE id=$1`, f.marker.id);
        if (target === 'truncate') await tx.$executeRawUnsafe(`TRUNCATE TABLE ${application}.reservation_engine_mode_configs`);
      })).rejects.toThrow(expected);
      expect(await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } })).toEqual(modes);
      expect(await f.db.cartItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(item);
      expect(await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).toEqual(f.marker);
    }
  }));
  it('direct enrolled mode TRUNCATE rejects from its own guard and retains every row', () => fixture(async f => {
    const before = await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } });
    await expect(f.db.$executeRaw`TRUNCATE TABLE reservation_engine_mode_configs`).rejects.toThrow('enrolled mode history cannot be truncated');
    expect(await f.db.reservationEngineModeConfig.findMany({ orderBy: { revision: 'asc' } })).toEqual(before);
  }));
  it('publishes existing cart repository write, marker and result in one transaction; replay never calls domain again', () => fixture(async (f, request, repo, publication) => {
    const scope = request.scopes[0]!;
    if (scope.kind !== 'MARKER' || !scope.cartAfter) throw new Error('Invalid fixture');
    const domain = jest.fn(async (tx: Parameters<CartRepository['updateItemQuantity']>[2]) => {
      if (!tx) throw new Error('Missing transaction');
      await new CartRepository(f.db).updateItemQuantity(scope.cartAfter!.id, 3, tx);
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: {
        generation: 1, expectedMutationVersion: scope.after.mutationVersion, expectedQuantity: 3 } });
      return { result: 'published' };
    });
    const result = await publication.publish(request.intentId, domain);
    expect(result.status).toBe('PUBLISHED');
    expect((await repo.read(request.intentId))?.resultReference).toEqual({ result: 'published' });
    expect((await publication.publish(request.intentId, domain)).id).toBe(result.id);
    expect(domain).toHaveBeenCalledTimes(1);
    expect((await f.db.cartItem.findUniqueOrThrow({ where: { id: scope.cartAfter.id } })).quantity).toBe(3);
  }));
  it('domain failure rolls back cart, marker, result and publication while retaining confirmed barrier', () => fixture(async (f, request, repo, publication) => {
    const scope = request.scopes[0]!;
    if (scope.kind !== 'MARKER' || !scope.cartBefore) throw new Error('Invalid fixture');
    await expect(publication.publish(request.intentId, async tx => {
      await new CartRepository(f.db).updateItemQuantity(scope.cartBefore!.id, 3, tx);
      throw new Error('DOMAIN_ABORT');
    })).rejects.toThrow('DOMAIN_ABORT');
    expect((await repo.read(request.intentId))?.status).toBe('BARRIER_CONFIRMED');
    expect((await repo.read(request.intentId))?.publicationTx).toBeNull();
    expect((await f.db.cartItem.findUniqueOrThrow({ where: { id: scope.cartBefore.id } })).quantity).toBe(scope.cartBefore.quantity);
    expect((await f.db.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.marker.id } })).generation).toBe(0);
  }));
  it('cannot publish without the exact intended domain effects, including raw status manipulation', () => fixture(async (f, request, repo, publication) => {
    await expect(publication.publish(request.intentId, () => Promise.resolve({ forged: true }))).rejects.toThrow();
    await expect(f.db.$transaction(async tx => {
      const [row] = await tx.$queryRaw<{ id: bigint }[]>`SELECT txid_current() AS id`;
      await tx.ordinaryInvalidationIntent.update({ where: { id: request.intentId }, data: { publicationTx: row!.id } });
      await tx.ordinaryInvalidationIntent.update({ where: { id: request.intentId }, data: {
        status: 'PUBLISHED', publishedAt: new Date(), resultReference: { forged: true } } });
      await tx.ordinaryInvalidationHead.update({ where: { scope: `MARKER:${f.marker.id}` }, data: { publishedRevision: 1, pendingIntentId: null } });
    })).rejects.toThrow();
    expect((await repo.read(request.intentId))?.status).toBe('BARRIER_CONFIRMED');
  }));
  it('mode restriction uses the existing transaction and exclusive lock; rollback is atomic and never calls Redis', () => fixture(async (f, request, repo, publication) => {
    const forbiddenRedis = jest.fn(() => { throw new Error('REDIS_IN_PUBLICATION'); });
    const testingModule = await Test.createTestingModule({ providers: [ReservationEngineModeService,
      { provide: PrismaService, useValue: f.db },
      { provide: ReservationEngineModeConfigRepository, useValue: new ReservationEngineModeConfigRepository(f.db) },
      { provide: RedisService, useValue: { eval: forbiddenRedis, get: forbiddenRedis, scan: forbiddenRedis } },
      { provide: InventoryReservationsService, useValue: {} },
      { provide: CartMutationBarrierConfigRepository, useValue: {} },
    ] }).compile();
    try {
      const modes = testingModule.get(ReservationEngineModeService), input = { targetMode: 'DRAINING' as const, updatedById: f.customerId };
      await expect(f.db.$transaction(tx => modes.restrictInTransaction(tx, input))).rejects.toThrow('EXCLUSIVE_MODE_PUBLICATION_LOCK_REQUIRED');
      await expect(f.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
        return modes.restrictInTransaction(tx, input);
      })).rejects.toThrow('EXCLUSIVE_MODE_PUBLICATION_LOCK_REQUIRED');
      const tuple = transitionTuple(f.transition);
      const modeRequest: InvalidationRequest = { ...request, intentId: randomUUID(), operationId: randomUUID(), kind: 'MODE',
        scopes: [{ kind: 'GLOBAL', revision: 0, before: tuple, after: tuple,
          modeBefore: { mode: 'CART_SCOPED', revision: f.transition.modeRevision }, modeAfter: 'DRAINING' }] };
      await repo.prepare(modeRequest); await repo.confirm(modeRequest, barrierAcknowledgement(modeRequest));
      await expect(publication.publish(modeRequest.intentId, async tx => {
        expect(await modes.restrictInTransaction(tx, { ...input, targetMode: 'CART_SCOPED' })).toMatchObject({ ok: false });
        expect(await modes.restrictInTransaction(tx, input)).toMatchObject({ ok: true, mode: 'DRAINING' });
        throw new Error('MODE_ROLLBACK');
      })).rejects.toThrow('MODE_ROLLBACK');
      expect(await modes.getCurrentMode()).toBe('CART_SCOPED');
      expect((await repo.read(modeRequest.intentId))?.status).toBe('BARRIER_CONFIRMED');
      const transactions = jest.spyOn(f.db, '$transaction');
      expect((await publication.publishMode(modeRequest.intentId, modes, input)).status).toBe('PUBLISHED');
      expect(transactions).toHaveBeenCalledTimes(1);
      transactions.mockRestore();
      expect(await modes.getCurrentMode()).toBe('DRAINING');
      expect(await f.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reservation_engine_mode_transition'))`;
        return modes.restrictInTransaction(tx, { ...input, targetMode: 'CART_SCOPED' });
      })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', from: 'DRAINING', to: 'CART_SCOPED' });
      expect(forbiddenRedis).not.toHaveBeenCalled();
    } finally { jest.restoreAllMocks(); await testingModule.close(); }
  }));

  it('resolves a committed publication response loss by reading the retained result without rerunning the domain callback', () => fixture(async (f, request, repo, publication) => {
    const scope = request.scopes[0]!;
    if (scope.kind !== 'MARKER' || !scope.cartAfter) throw new Error('Invalid fixture');
    const original = repo.locked.bind(repo);
    jest.spyOn(repo, 'locked').mockImplementation(async (input, work) => {
      await original(input, work); throw new Error('COMMIT_RESPONSE_LOST');
    });
    try {
      const domain = jest.fn(async (tx: Parameters<CartRepository['updateItemQuantity']>[2]) => {
        if (!tx) throw new Error('Missing transaction');
        await new CartRepository(f.db).updateItemQuantity(scope.cartAfter!.id, 3, tx);
        await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: {
          generation: 1, expectedMutationVersion: scope.after.mutationVersion, expectedQuantity: 3 } });
        return { result: 'committed' };
      });
      expect((await publication.publish(request.intentId, domain)).status).toBe('PUBLISHED');
      expect(domain).toHaveBeenCalledTimes(1);
    } finally { jest.restoreAllMocks(); }
  }));
});
