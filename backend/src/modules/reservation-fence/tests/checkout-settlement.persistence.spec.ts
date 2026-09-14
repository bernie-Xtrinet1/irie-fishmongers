import { randomUUID } from 'crypto';
import { ordinaryHoldInstanceId } from '../ordinary-hold-instance-id';
import { Redis } from 'ioredis';
import { RedisService } from '../../../common/redis/redis.service';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { CheckoutSettlementAuthorityService } from '../services/checkout-settlement-authority.service';
import { readSettlementCompletion, SettlementCompletionEvidence } from '../services/checkout-settlement-evidence';
import { settlementProtocol, settlementReceiptKey, checkoutPinKey } from '../lua/checkout-settlement.lua';
import { resourceGuardKey, executionGateKey } from '../lua/reservation-mutation-common.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { transitionTuple } from '../repositories/reservation-fence.repository';
import { PrismaService } from '../../../database/prisma.service';
import { seedCartAndProduct, setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { CheckoutSettlementRepository } from '../repositories/checkout-settlement.repository';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { withSettlementSchema } from './checkout-settlement-test-helpers';

async function fixture(db: PrismaService) {
  const f = await setUpCompensationFixture(db);
  const ids = await seedCartAndProduct(f);
  const mode = await db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: ids.customerId } });
  const fence = await db.reservationFenceTransition.create({ data: { id: randomUUID(), incarnation: randomUUID(),
    epoch: 1, revision: mode.revision, phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(),
    mode: 'CART_SCOPED', modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
  const marker = await db.cartReservationSyncState.create({ data: { cartId: ids.cartId, productId: ids.productId,
    generation: 1, expectedQuantity: 2, expectedMutationVersion: 1 } });
  const op = await db.checkoutOperation.create({ data: { ...{ cartId: ids.cartId, customerId: ids.customerId },
    operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED',
    reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
  const attempt = await db.checkoutAttempt.create({ data: { cartId: ids.cartId, customerId: ids.customerId,
    idempotencyKey: op.operationKey, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1 } });
  const fences = new ReservationFenceRepository(db);
  return { ...ids, fence, marker, op, attempt, repo: new CheckoutSettlementRepository(db, fences) };
}

// Each case upgrades an isolated schema. Evidence retention cannot contaminate
// other suites; cleanup drops only the generated fixture schema.
describe('durable settlement manifests and forward migrations', () => {
  jest.setTimeout(120000);
  it('waits for a concurrent durable marker update and captures one coherent new identity/quantity', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    let release!: () => void, ready!: (pid: number) => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const writer = db.$transaction(async tx => {
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2, expectedQuantity: 3 } });
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(row!.pid); await released;
    });
    let preparing: ReturnType<typeof f.repo.prepare> | undefined;
    try {
      const pid = await locked;
      preparing = f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const rows = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = rows[0]!.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      release(); await writer;
      const manifest = await preparing;
      expect(manifest.resources[0]).toMatchObject({ markerId: f.marker.id, generation: 2, quantity: 3,
        holdInstanceId: ordinaryHoldInstanceId(f.marker.id, 2) });
    } finally {
      release(); await writer; if (preparing) await preparing;
    }
  }));
  it('44 -> 45 removes only the global hold index and retains duplicate historical references across reconnect', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db);
    const first = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    const resource = first.resources[0]!;
    const capture = () => db.$transaction(async tx => {
      const operationKey = randomUUID();
      const op = await tx.checkoutOperation.create({ data: { cartId: f.cartId, customerId: f.customerId,
        operationKey, retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED',
        reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
      const attempt = await tx.checkoutAttempt.create({ data: { cartId: f.cartId, customerId: f.customerId,
        idempotencyKey: operationKey, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 1 } });
      const m = await tx.checkoutReservationSettlement.create({ data: { operationId: op.id, attemptId: attempt.id,
        incarnation: f.fence.incarnation, captureTransitionId: f.fence.id, reservationExecutionEpoch: 1,
        acquisitionReplayId: randomUUID(), resources: { create: { productId: resource.productId,
          markerId: resource.markerId, generation: resource.generation, quantity: resource.quantity,
          holdInstanceId: resource.holdInstanceId } } } });
      return tx.checkoutReservationSettlement.update({ where: { id: m.id }, data: { sealed: true }, include: { resources: true } });
    });
    await expect(capture()).rejects.toMatchObject({ code: 'P2002' });
    const constraints = () => db.$queryRaw`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY conname`;
    const triggers = () => db.$queryRaw`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace) ORDER BY tgname, definition`;
    const functions = () => db.$queryRaw`SELECT proname, prosrc FROM pg_proc WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
    const indexes = () => db.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`;
    const before = { constraints: await constraints(), triggers: await triggers(), functions: await functions(), indexes: await indexes() };
    expect(before.indexes.some(i => i.indexname === 'checkout_reservation_resources_holdInstanceId_key')).toBe(true);
    upgrade();
    expect(await constraints()).toEqual(before.constraints);
    expect(await triggers()).toEqual(before.triggers);
    expect(await functions()).toEqual(before.functions);
    expect(await indexes()).toEqual(before.indexes.filter(i => i.indexname !== 'checkout_reservation_resources_holdInstanceId_key'));
    for (const column of ['productId', 'markerId'])
      expect((await indexes()).find(i => i.indexname === `checkout_reservation_resources_settlementId_${column}_key`)?.indexdef)
        .toContain(`UNIQUE INDEX "checkout_reservation_resources_settlementId_${column}_key"`);
    const second = await capture();
    expect(second.id).not.toBe(first.id);
    expect(second.resources[0]!.holdInstanceId).toBe(resource.holdInstanceId);
    await db.$disconnect(); await db.$connect();
    expect(await f.repo.find(first.id)).toEqual(first);
    expect(await db.checkoutReservationResource.count({ where: { holdInstanceId: resource.holdInstanceId } })).toBe(2);
    await expect(db.checkoutReservationResource.delete({ where: { id: second.resources[0]!.id } })).rejects.toThrow();
    await expect(db.checkoutReservationResource.update({ where: { id: resource.id }, data: { quantity: 3 } })).rejects.toThrow();
    // Restoring global uniqueness cannot succeed once historical references repeat.
    // PostgreSQL's failed CREATE is atomic; retained resources are never rewritten.
    await expect(db.$executeRaw`CREATE UNIQUE INDEX "checkout_reservation_resources_holdInstanceId_key" ON checkout_reservation_resources ("holdInstanceId")`).rejects.toThrow();
    expect(await indexes()).toEqual(before.indexes.filter(i => i.indexname !== 'checkout_reservation_resources_holdInstanceId_key'));
  }, 44));

  it.each([{ generation: -1, quantity: 2 }, { generation: 1, quantity: 0 },
    { generation: 1, quantity: -1 }])('retains resource bounds for %j', values => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    await expect(db.$transaction(async tx => {
      const m = await tx.checkoutReservationSettlement.create({ data: { operationId: f.op.id, attemptId: f.attempt.id,
        incarnation: f.fence.incarnation, captureTransitionId: f.fence.id, reservationExecutionEpoch: 1, acquisitionReplayId: randomUUID() } });
      await tx.checkoutReservationResource.create({ data: { settlementId: m.id, markerId: f.marker.id,
        productId: f.productId, holdInstanceId: randomUUID(), ...values } });
      await tx.checkoutReservationSettlement.update({ where: { id: m.id }, data: { sealed: true } });
    })).rejects.toThrow();
    expect(await db.checkoutReservationSettlement.count()).toBe(0);
    const bounds = await db.$queryRaw<{ definition: string }[]>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'settlement_resource_bounds'`;
    expect(bounds[0]?.definition).toBe('CHECK (((generation >= 0) AND (quantity > 0)))');
  }));
  it('still rejects duplicate manifest-local membership with distinct physical IDs', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    await expect(db.$transaction(async tx => {
      const m = await tx.checkoutReservationSettlement.create({ data: { operationId: f.op.id, attemptId: f.attempt.id,
        incarnation: f.fence.incarnation, captureTransitionId: f.fence.id, reservationExecutionEpoch: 1, acquisitionReplayId: randomUUID() } });
      const data = { settlementId: m.id, markerId: f.marker.id, productId: f.productId, generation: 1, quantity: 2 };
      await tx.checkoutReservationResource.create({ data: { ...data, holdInstanceId: randomUUID() } });
      await tx.checkoutReservationResource.create({ data: { ...data, holdInstanceId: randomUUID() } });
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.checkoutReservationSettlement.count()).toBe(0);
  }));
  it('preserves historical rows and all prior constraints/indexes without backfill', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db);
    const historical = await db.checkoutAttempt.create({ data: { cartId: f.cartId, customerId: f.customerId, idempotencyKey: randomUUID() } });
    const before = await db.$queryRaw<{ name: string }[]>`SELECT conname AS name FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY conname`;
    const indexes = await db.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`;
    upgrade();
    expect(await db.checkoutAttempt.findUnique({ where: { id: historical.id } })).toEqual(historical);
    expect(await db.checkoutReservationSettlement.count()).toBe(0);
    const after = await db.$queryRaw<{ name: string }[]>`SELECT conname AS name FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY conname`;
    expect(after).toEqual(expect.arrayContaining(before));
    expect(await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`).toEqual(expect.arrayContaining(indexes));
  }));
  it.each(['historical', 'legacy', 'customer', 'epoch', 'key'] as const)('rejects %s provenance without changing selectedPath', kind => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    if (kind === 'historical' || kind === 'legacy') {
      const op = await db.checkoutOperation.create({ data: { cartId: f.cartId, customerId: f.customerId,
        operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: kind === 'legacy' ? 'LEGACY' : 'CART_SCOPED' } });
      const a = await db.checkoutAttempt.create({ data: { cartId: f.cartId, customerId: f.customerId, idempotencyKey: op.operationKey, selectedPath: op.selectedPath } });
      await expect(f.repo.prepare(op.id, a.id, f.customerId)).rejects.toThrow();
      expect((await db.checkoutOperation.findUniqueOrThrow({ where: { id: op.id } })).selectedPath).toBe(op.selectedPath);
    } else {
      await expect(kind === 'customer' ? f.repo.prepare(f.op.id, f.attempt.id, randomUUID()) :
        db.checkoutReservationSettlement.create({ data: { operationId: kind === 'key' ? randomUUID() : f.op.id,
          attemptId: f.attempt.id, incarnation: f.fence.incarnation, captureTransitionId: f.fence.id,
          reservationExecutionEpoch: kind === 'epoch' ? 2 : 1, acquisitionReplayId: randomUUID() } })).rejects.toThrow();
    }
  }));
  it('seals immutable membership and rejects empty, duplicate and oversized capture', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    const m = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    expect(m.state).toBe('PREPARED'); expect(m.sealed).toBe(true);
    expect(await f.repo.prepare(f.op.id, f.attempt.id, f.customerId)).toEqual(m);
    for (const data of [{ generation: 2 }, { holdInstanceId: randomUUID() }, { quantity: 3 }])
      await expect(db.checkoutReservationResource.update({ where: { id: m.resources[0]!.id }, data })).rejects.toThrow();
    await expect(db.checkoutReservationResource.create({ data: { ...m.resources[0]!, id: randomUUID() } })).rejects.toThrow();
    await expect(db.checkoutReservationSettlement.update({ where: { id: m.id }, data: { sealed: false } })).rejects.toThrow();
    await expect(db.checkoutReservationSettlement.delete({ where: { id: m.id } })).rejects.toThrow();
    expect(() => f.repo.discover('PREPARED', 101)).toThrow();
    expect(await f.repo.discover('PREPARED', 100)).toEqual([{ id: m.id }]);
  }));
  it('requires durable failure, retains action, discovers obligations after reconnect and permits captured generation', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    const m = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    await expect(db.$transaction(tx => f.repo.markRevertPending(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY'))).rejects.toThrow();
    await db.$transaction(async tx => {
      await tx.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { status: 'FAILED', failureCode: 'TEST_FAILURE' } });
      expect(await f.repo.markRevertPending(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY')).toEqual({ count: 1 });
    });
    await db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2, expectedQuantity: null } });
    await db.$disconnect(); await db.$connect();
    expect(await new CheckoutSettlementRepository(db, new ReservationFenceRepository(db)).discover('REVERT_PENDING', 10)).toEqual([{ id: m.id }]);
    await expect(db.$transaction(tx => f.repo.authority(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY'))).resolves.toMatchObject({ manifest: { state: 'REVERT_PENDING' } });
    await expect(db.$transaction(tx => f.repo.authority(tx, m.id, 'ACQUIRE'))).rejects.toThrow();
    await expect(db.$transaction(tx => tx.checkoutReservationSettlement.update({ where: { id: m.id }, data: { state: 'ACQUIRED' } }))).rejects.toThrow();
    await expect(db.$transaction(tx => tx.checkoutReservationSettlement.update({ where: { id: m.id }, data: { state: 'SETTLED', effect: 'CHECKOUT_FINALIZE' } }))).rejects.toThrow();
  }));
  it('PREPARED cannot authorize finalize, ordinary mutations or claim acquisition succeeded', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade(); const m = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    for (const action of ['CHECKOUT_FINALIZE', 'CHECKOUT_REVERT_DELETE_ONLY', 'RESERVE', 'RENEW', 'RECONCILE_POSITIVE'])
      await expect(db.$transaction(tx => f.repo.authority(tx, m.id, action as 'CHECKOUT_FINALIZE'))).rejects.toThrow();
    await expect(db.$transaction(tx => tx.checkoutReservationSettlement.update({ where: { id: m.id }, data: { state: 'FINALIZE_PENDING', effect: 'CHECKOUT_FINALIZE', settlementReplayId: randomUUID() } }))).rejects.toThrow();
    expect((await f.repo.find(m.id))?.state).toBe('PREPARED');
  }));
  it('persists committed obligation with order, survives restart, and rejects a mismatched order scope', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade(); const m = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    const results = await Promise.all([0, 1].map(() => db.$transaction(tx => f.repo.markAcquired(tx, m.id))));
    expect(results.map(r => r.count).sort()).toEqual([0, 1]);
    const product = await db.product.findUniqueOrThrow({ where: { id: f.productId } });
    const order = await db.$transaction(async tx => {
      const created = await tx.order.create({ data: { customerId: f.customerId, deliveryAddressLine1: 'fixture',
        deliveryPhone: '000', deliveryParish: 'KINGSTON', vendorOrders: { create: { vendorId: product.vendorId,
          subtotal: 2, items: { create: { productId: product.id, productName: product.name, unit: product.unit,
            unitPrice: 1, quantity: 2, subtotal: 2 } } } } } });
      await tx.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { status: 'COMMITTED', orderId: created.id } });
      await f.repo.markFinalizePending(tx, m.id);
      await tx.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 2, expectedQuantity: null } });
      return created;
    });
    await db.$disconnect(); await db.$connect();
    expect(await new CheckoutSettlementRepository(db, new ReservationFenceRepository(db)).discover('FINALIZE_PENDING', 10)).toEqual([{ id: m.id }]);
    await expect(db.$transaction(tx => f.repo.authority(tx, m.id, 'CHECKOUT_FINALIZE'))).resolves.toMatchObject({ manifest: { state: 'FINALIZE_PENDING' } });
    await db.orderItem.updateMany({ where: { vendorOrder: { orderId: order.id } }, data: { quantity: 3 } });
    await expect(db.$transaction(tx => f.repo.authority(tx, m.id, 'CHECKOUT_FINALIZE'))).rejects.toThrow('SETTLEMENT_ORDER_MISMATCH');
  }));
  it('rejects empty and over-limit prospective resource sets before manifest creation', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade();
    await db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { expectedQuantity: null } });
    await expect(f.repo.prepare(f.op.id, f.attempt.id, f.customerId)).rejects.toThrow('SETTLEMENT_RESOURCE_LIMIT');
    const product = await db.product.findUniqueOrThrow({ where: { id: f.productId } });
    const products = Array.from({ length: 101 }, () => ({ ...product, id: randomUUID() }));
    await db.product.createMany({ data: products });
    await db.cartReservationSyncState.createMany({ data: products.map(p => ({ cartId: f.cartId, productId: p.id,
      expectedQuantity: 2, expectedMutationVersion: 1, generation: 1 })) });
    await expect(f.repo.prepare(f.op.id, f.attempt.id, f.customerId)).rejects.toThrow('SETTLEMENT_RESOURCE_LIMIT');
    expect(await db.checkoutReservationSettlement.count()).toBe(0);
  }));
  it('acknowledges SETTLED only with protocol-produced completion evidence for the selected durable action', () => withSettlementSchema(async (db, upgrade) => {
    const f = await fixture(db); upgrade(); const m = await f.repo.prepare(f.op.id, f.attempt.id, f.customerId);
    expect(m.settlementReplayId).toBeNull();
    const redis = new Redis(process.env.REDIS_URL!);
    const client = new RedisService(redis);
    const keys = [RESERVATION_FENCE_KEY, executionGateKey(f.op.id), settlementReceiptKey(m.id),
      `reservation:fence:settlement-acquisition:${m.id}`,
      ...m.resources.flatMap(r => [resourceGuardKey(r.markerId), checkoutPinKey(r.markerId)])];
    await withCleanup(() => withCleanup(async () => {
      expect(await redis.exists(RESERVATION_FENCE_KEY)).toBe(0);
      await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(f.fence)));
      await redis.set(executionGateKey(f.op.id), JSON.stringify({ incarnation: m.incarnation, epoch: m.reservationExecutionEpoch,
        operationId: f.op.id, gateId: f.op.id, state: 'ENABLED' }));
      for (const r of m.resources) await redis.set(resourceGuardKey(r.markerId), JSON.stringify({ incarnation: m.incarnation,
        epoch: m.reservationExecutionEpoch, resource: { markerId: r.markerId, productId: r.productId, cartId: f.cartId,
          customerId: f.customerId, generation: r.generation, holdInstanceId: r.holdInstanceId } }));
      const issuer = new CheckoutSettlementAuthorityService(f.repo, new ReservationFenceRepository(db), client);
      const acquire = await issuer.register(m.id, 'ACQUIRE'); keys.push(acquire.key);
      expect(acquire.result).toMatchObject({ code: 'ACCEPTED' });
      // Synthetic composition only, not W4 inventory acquisition integration.
      expect(JSON.parse(await redis.eval(settlementProtocol('ACQUIRE', '', ''), 2, RESERVATION_FENCE_KEY, acquire.key) as string) as object)
        .toMatchObject({ code: 'ACCEPTED' });
      await db.$transaction(async tx => {
        await tx.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { status: 'FAILED', failureCode: 'TEST' } });
        await f.repo.markRevertPending(tx, m.id, 'CHECKOUT_REVERT_DELETE_ONLY');
      });
      const pending = await f.repo.find(m.id); if (!pending) throw new Error('Missing fixture');
      expect(pending.settlementReplayId).not.toBe(pending.acquisitionReplayId);
      await expect(db.$transaction(tx => f.repo.acknowledgeSettled(tx, m.id, {} as SettlementCompletionEvidence))).rejects.toThrow('SETTLEMENT_COMPLETION_EVIDENCE_REQUIRED');
      await expect(db.checkoutReservationSettlement.update({ where: { id: m.id }, data: { state: 'SETTLED' } })).rejects.toThrow();
      await expect(readSettlementCompletion(client, pending)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
      await expect(db.checkoutReservationSettlement.update({ where: { id: m.id }, data: { settlementReplayId: m.acquisitionReplayId } })).rejects.toThrow();
      await expect(issuer.register(m.id, 'CHECKOUT_FINALIZE')).rejects.toThrow();
      const settle = await issuer.register(m.id, 'CHECKOUT_REVERT_DELETE_ONLY'); keys.push(settle.key);
      expect(JSON.parse(await redis.eval(settlementProtocol('CHECKOUT_REVERT_DELETE_ONLY', '', ''), 2, RESERVATION_FENCE_KEY, settle.key) as string) as object)
        .toMatchObject({ code: 'ACCEPTED' });
      const evidence = await readSettlementCompletion(client, pending);
      expect(await db.$transaction(tx => f.repo.acknowledgeSettled(tx, m.id, evidence))).toEqual({ count: 1 });
      expect(await db.$transaction(tx => f.repo.acknowledgeSettled(tx, m.id, evidence))).toEqual({ count: 0 });
      const settled = await f.repo.find(m.id);
      expect(settled?.state).toBe('SETTLED');
      expect(settled?.completionReceiptHash).toMatch(/^[a-f0-9]{64}$/);
    }, [() => redis.del(...keys)]), [() => redis.quit()]);
  }));
});
