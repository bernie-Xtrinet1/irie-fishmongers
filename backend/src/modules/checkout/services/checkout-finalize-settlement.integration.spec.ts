import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { OrderWithDetails } from '../../orders/repositories/orders.repository';
import { checkoutDto } from './checkout-coordinator-integration-test-helpers';
import { CheckoutFinalizeSettlementService } from './checkout-finalize-settlement.service';
import { buildLegacyPricingSnapshot } from '../../orders/services/legacy-pricing-snapshot.builder';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';
import { readSettlementCompletion, SettlementCompletionEvidence, settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, executionGateKey, resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { checkoutPinKey, settlementReceiptKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT } from '../../inventory/lua/checkout-settlement-finalize-lua-scripts';
import { cartIndexKey, productIndexKey, reservationKey, productTotalKey, productSuspectKey } from '../../inventory/constants/inventory.constants';
import { connectRealRedis, cleanupKeys, trackKeysFor } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { openAcquisitionSchema } from './checkout-acquisition-test-helpers';
import { buildRealCoordinator, seedReadyCheckout, setUpCheckoutIntegrationFixture } from './checkout-coordinator-integration-test-helpers';
import { CheckoutAcquisitionService } from './checkout-acquisition.service';
import { CheckoutFailureSettlementService } from './checkout-failure-settlement.service';

describe('G.4b.2c.4 atomic commitment and exact physical W6', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openAcquisitionSchema>>;
  let redis: Awaited<ReturnType<typeof connectRealRedis>>;
  let fixture: Awaited<ReturnType<typeof setUpCheckoutIntegrationFixture>>;
  let handles: ReturnType<typeof buildRealCoordinator>;
  let fences: ReservationFenceRepository, repo: CheckoutSettlementRepository;
  let adapter: RedisService, authority: CheckoutSettlementAuthorityService;
  let acquisition: CheckoutAcquisitionService, service: CheckoutFinalizeSettlementService;
  let failure: CheckoutFailureSettlementService;
  const keys = new Set<string>();
  beforeAll(async () => {
    schema = await openAcquisitionSchema(); redis = await connectRealRedis();
    fixture = await setUpCheckoutIntegrationFixture(schema.prisma);
    handles = buildRealCoordinator(schema.prisma, redis);
    fences = new ReservationFenceRepository(schema.prisma); repo = new CheckoutSettlementRepository(schema.prisma, fences);
    adapter = new RedisService(redis); authority = new CheckoutSettlementAuthorityService(repo, fences, adapter);
    acquisition = new CheckoutAcquisitionService(schema.prisma, adapter, repo, fences, authority,
      new ReservationMutationAuthorityService(fences, adapter));
    service = fresh();
    failure = new CheckoutFailureSettlementService(schema.prisma, adapter, new CheckoutAttemptRepository(schema.prisma), repo, fences, authority);
    const mode = await schema.prisma.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: fixture.userIds[0]! } });
    const fence = await schema.prisma.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 1,
      revision: 1, phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(),
      mode: 'CART_SCOPED', modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
    keys.add(RESERVATION_FENCE_KEY); keys.add(MUTATION_HISTORY_KEY);
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
    await redis.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => withCleanup(async () => {
    if (schema) for (const m of await schema.prisma.checkoutReservationSettlement.findMany({ include: { resources: true } })) {
      keys.add(executionGateKey(m.operationId)); keys.add(settlementReceiptKey(m.id));
      keys.add(`reservation:fence:settlement-acquisition:${m.id}`);
      for (const r of m.resources) { keys.add(resourceGuardKey(r.markerId)); keys.add(checkoutPinKey(r.markerId)); }
    }
  }, [async () => { if (redis) await cleanupKeys(redis, keys); }, async () => { if (redis) await redis.quit(); },
    async () => { if (schema) await schema.close(); }]));
  function fresh() { return new CheckoutFinalizeSettlementService(schema.prisma, adapter, repo, fences, authority); }
  async function prepared(twoResources = false) {
    const f = await seedReadyCheckout(fixture, handles);
    trackKeysFor(keys, f.cartId, f.productId);
    const item = await handles.cartRepository.findItemByCartAndProduct(f.cartId, f.productId);
    await handles.syncStateRepository.upsertDesiredState(f.cartId, f.productId, item!.mutationVersion, f.quantity);
    if (twoResources) {
      const other = await seedReadyCheckout(fixture, handles);
      trackKeysFor(keys, other.cartId, other.productId); trackKeysFor(keys, f.cartId, other.productId);
      await handles.cartRepository.addOrIncrementItem(f.cartId, other.productId, other.quantity);
      const extraItem = await handles.cartRepository.findItemByCartAndProduct(f.cartId, other.productId);
      await handles.syncStateRepository.upsertDesiredState(f.cartId, other.productId, extraItem!.mutationVersion, other.quantity);
      expect(await handles.inventoryReservations.reserveOrRenew(f.cartId, other.productId, f.customerId, other.quantity))
        .toMatchObject({ ok: true });
    }
    const op = await schema.prisma.checkoutOperation.create({ data: { customerId: f.customerId, cartId: f.cartId,
      operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED',
      reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' } });
    const attempt = await new CheckoutAttemptRepository(schema.prisma).createWithReservationCapability({
      operationKey: op.operationKey, customerId: f.customerId, cartId: f.cartId, epoch: 1 }, schema.prisma);
    const m = await repo.prepare(op.id, attempt.id, f.customerId);
    return { ...f, op, attempt, m };
  }
  async function acquired(twoResources = false) {
    const f = await prepared(twoResources); const result = await acquisition.acquire(f.customerId, f.op.id);
    if (!result.ok) throw new Error('Fixture acquisition failed');
    return { ...f, evidence: result.evidence };
  }
  async function commit(f: Awaited<ReturnType<typeof acquired>>, tx: Prisma.TransactionClient) {
    const preparation = await handles.ordersService.prepareCheckout(f.customerId, checkoutDto);
    if (!preparation.ok) throw new Error('Fixture preparation failed');
    const order = await handles.ordersService.createOrderInTransaction(tx, preparation.prepared,
      buildLegacyPricingSnapshot(preparation.prepared.cart));
    const result = await handles.checkoutAttemptService.markCommittedInTransaction(tx,
      f.attempt.id, f.customerId, order.id, new Date());
    if (!result.ok) throw new Error('Commit attempt failed');
    return order;
  }
  async function pending(twoResources = false) {
    const f = await acquired(twoResources);
    expect(await failure.runOrder(f.evidence, tx => commit(f, tx))).toMatchObject({ kind: 'CREATED' });
    const m = (await repo.find(f.m.id))!;
    expect(m).toMatchObject({ state: 'FINALIZE_PENDING', effect: 'CHECKOUT_FINALIZE', attempt: { status: 'COMMITTED' } });
    expect(m.attempt.orderId).not.toBeNull();
    expect(m.settlementReplayId).not.toBeNull(); expect(m.settlementReplayId).not.toBe(m.acquisitionReplayId);
    return { ...f, m };
  }

  it('commits order, cleared cart, stock and terminal obligation atomically, then consumes exact resources once', async () => {
    const f = await pending(true);
    const order = await schema.prisma.order.findUniqueOrThrow({ where: { id: f.m.attempt.orderId! } });
    expect(order.customerId).toBe(f.customerId);
    expect(await schema.prisma.cartItem.count({ where: { cartId: f.cartId } })).toBe(0);
    const before = await Promise.all(f.m.resources.map(r => redis.get(productTotalKey(r.productId))));
    for (const r of f.m.resources) {
      expect((await schema.prisma.cartReservationSyncState.findUniqueOrThrow({ where: { id: r.markerId } })).generation).toBeGreaterThan(r.generation);
    }
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    for (const [i, r] of f.m.resources.entries()) {
      expect(await redis.get(reservationKey(f.cartId, r.productId))).toBeNull();
      expect(await redis.get(checkoutPinKey(r.markerId))).toBeNull();
      expect(Number(await redis.get(productTotalKey(r.productId)))).toBe(Number(before[i]) - r.quantity);
    }
    expect(JSON.parse((await redis.get(settlementReceiptKey(f.m.id)))!)).toEqual({ identity: settlementOwnershipIdentity(f.m),
      action: 'CHECKOUT_FINALIZE', replayId: f.m.settlementReplayId, complete: true });
    const execute = jest.spyOn(adapter, 'eval'), select = jest.spyOn(repo, 'markFinalizePending');
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT)).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'SETTLED', settlementReplayId: f.m.settlementReplayId });
  });
  it.each(['finalize-intent', 'attempt-commit'] as const)('%s failure rolls back order, cart, stock and attempt before W5 resolution', async point => {
    const f = await acquired();
    const product = await schema.prisma.product.findUniqueOrThrow({ where: { id: f.productId } });
    const marker = await schema.prisma.cartReservationSyncState.findUniqueOrThrow({ where: { id: f.m.resources[0]!.markerId } });
    // Stop only the subsequent W5 intent, exposing the durable rollback state.
    jest.spyOn(repo, 'markRevertPending').mockRejectedValueOnce(new Error('Hold rollback state for inspection'));
    if (point === 'finalize-intent') jest.spyOn(repo, 'markFinalizePending').mockResolvedValueOnce({ count: 0 });
    else jest.spyOn(handles.checkoutAttemptService, 'markCommittedInTransaction').mockResolvedValueOnce({ ok: false, code: 'INVALID_TRANSITION' });
    expect(await failure.runOrder(f.evidence, tx => commit(f, tx))).toEqual({ kind: 'UNRESOLVED' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'ACQUIRED', effect: null, settlementReplayId: null,
      attempt: { status: 'PROCESSING', orderId: null } });
    expect(await schema.prisma.order.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await schema.prisma.cartItem.count({ where: { cartId: f.cartId } })).toBe(1);
    expect((await schema.prisma.product.findUniqueOrThrow({ where: { id: f.productId } })).quantityAvailable).toBe(product.quantityAvailable);
    expect((await schema.prisma.cartReservationSyncState.findUniqueOrThrow({ where: { id: marker.id } })).generation).toBe(marker.generation);
  });
  it('lost actual COMMIT response finds FINALIZE_PENDING, never W5, and continues W6', async () => {
    const f = await acquired();
    const transact = schema.prisma.$transaction.bind(schema.prisma);
    jest.spyOn(schema.prisma, '$transaction').mockImplementationOnce(async work => {
      await transact(work as (tx: Prisma.TransactionClient) => Promise<OrderWithDetails>);
      throw new Error('COMMIT response lost');
    });
    const revert = jest.spyOn(failure, 'continue');
    expect(await failure.runOrder(f.evidence, tx => commit(f, tx))).toMatchObject({ kind: 'COMMITTED', attemptId: f.attempt.id });
    expect(revert).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', attempt: { status: 'COMMITTED' } });
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
  });
  it('historical COMMITTED plus ACQUIRED never manufactures terminal intent', async () => {
    const f = await acquired();
    await schema.prisma.$transaction(tx => commit(f, tx));
    const execute = jest.spyOn(adapter, 'eval'), select = jest.spyOn(repo, 'markFinalizePending');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'ORDER_OUTCOME_UNRESOLVED' });
    expect(execute).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'ACQUIRED', settlementReplayId: null });
  });
  it('second-resource conflict leaves both holds, totals, indexes and pins untouched', async () => {
    const f = await pending(true); const r = f.m.resources[1]!;
    const key = reservationKey(f.cartId, r.productId);
    const entry = JSON.parse((await redis.get(key))!) as { quantity: number }; entry.quantity++;
    await redis.set(key, JSON.stringify(entry), 'KEEPTTL');
    const snapshot = async () => Promise.all(f.m.resources.map(async resource => ({
      hold: await redis.get(reservationKey(f.cartId, resource.productId)),
      total: await redis.get(productTotalKey(resource.productId)),
      pin: await redis.get(checkoutPinKey(resource.markerId)),
      indexed: await redis.sismember(cartIndexKey(f.cartId), resource.productId),
    })));
    const before = await snapshot();
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(await snapshot()).toEqual(before);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
  });
  it('matching receipt without original-hold removal cannot acknowledge completion', async () => {
    const f = await pending();
    await redis.set(settlementReceiptKey(f.m.id), JSON.stringify({ identity: settlementOwnershipIdentity(f.m),
      action: 'CHECKOUT_FINALIZE', replayId: f.m.settlementReplayId, complete: true }));
    for (const r of f.m.resources) await redis.del(checkoutPinKey(r.markerId));
    await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_UNCERTAIN' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', completionReceiptHash: null });
  });
  it('registered replay cannot double decrement', async () => {
    const f = await pending(); const grant = await authority.register(f.m.id, 'CHECKOUT_FINALIZE');
    const execute = () => adapter.eval(CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT, [RESERVATION_FENCE_KEY, grant.key], []);
    const before = Number(await redis.get(productTotalKey(f.productId)));
    expect(JSON.parse(await execute() as string)).toMatchObject({ code: 'ACCEPTED', value: { completed: true } });
    expect(JSON.parse(await execute() as string)).toMatchObject({ code: 'ACCEPTED', value: { replayed: true } });
    expect(Number(await redis.get(productTotalKey(f.productId)))).toBe(before - f.quantity);
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
  });
  it('physical W6 can acquire all order boundary locks from a separate PostgreSQL client', async () => {
    const f = await pending(); const client = schema.newClient();
    const original = adapter.eval.bind(adapter); let checked = false;
    jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      if (args[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT) {
        await client.$transaction(async tx => {
          const locks = await tx.$queryRaw<{ held: boolean }[]>`SELECT pg_try_advisory_xact_lock(1380339280, 1) AS held`;
          expect(locks[0]!.held).toBe(true);
          await tx.$queryRaw`SELECT id FROM checkout_operations WHERE id = ${f.op.id} FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM checkout_attempts WHERE id = ${f.attempt.id} FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM checkout_reservation_settlements WHERE id = ${f.m.id}::uuid FOR UPDATE NOWAIT`;
          checked = true;
        });
      }
      return original(...args);
    });
    try { expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' }); expect(checked).toBe(true); }
    finally { await client.$disconnect(); }
  });
  it('committed-order quantity mismatch cannot issue W6 authority', async () => {
    const f = await pending();
    await schema.prisma.orderItem.updateMany({ where: { vendorOrder: { orderId: f.m.attempt.orderId! } }, data: { quantity: { increment: 1 } } });
    const execute = jest.spyOn(adapter, 'eval');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT)).toHaveLength(0);
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING' });
  });
  it.each(['wrong-pin', 'cart-index', 'product-index', 'accounting-type', 'accounting-value'] as const)('%s fails closed before any hold mutation', async kind => {
    const f = await pending(); const before = await redis.get(reservationKey(f.cartId, f.productId));
    if (kind === 'wrong-pin') await redis.set(checkoutPinKey(f.m.resources[0]!.markerId), 'wrong');
    if (kind === 'cart-index') await redis.srem(cartIndexKey(f.cartId), f.productId);
    if (kind === 'product-index') await redis.srem(productIndexKey(f.productId), f.cartId);
    if (kind === 'accounting-type') { await redis.del(productTotalKey(f.productId)); await redis.sadd(productTotalKey(f.productId), 'wrong'); }
    if (kind === 'accounting-value') await redis.set(productTotalKey(f.productId), 'not-an-integer');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(before);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
  });
  it.each(['before-execution', 'after-execution'] as const)('inactive coordinator replay continues W6 after %s loss and preserves successful order', async point => {
    const f = await acquired(); const original = adapter.eval.bind(adapter);
    const loss = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      if (args[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT && point === 'before-execution') throw new Error('Transport loss');
      const result = await original(...args);
      if (args[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT) throw new Error('Response loss');
      return result;
    });
    const run = () => handles.coordinator.checkoutAcquired(f.customerId, f.op.operationKey, checkoutDto,
      new Date(), f.evidence, failure, fresh());
    const first = await run(); expect(first.ok).toBe(true);
    const m = (await repo.find(f.m.id))!;
    expect(m).toMatchObject({ state: 'FINALIZE_PENDING', attempt: { status: 'COMMITTED' } });
    loss.mockRestore(); const execute = jest.spyOn(adapter, 'eval'), revert = jest.spyOn(failure, 'continue');
    const second = await run(); expect(second.ok).toBe(true);
    expect(await repo.find(m.id)).toMatchObject({ state: 'SETTLED', settlementReplayId: m.settlementReplayId,
      attempt: { orderId: m.attempt.orderId, status: 'COMMITTED' } });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT)).toHaveLength(point === 'before-execution' ? 1 : 0);
    expect(revert).not.toHaveBeenCalled();
    expect(await schema.prisma.order.count({ where: { customerId: f.customerId } })).toBe(1);
  });
  it.each(['incarnation', 'epoch', 'generation', 'productId'] as const)('wrong guard %s rejects without physical writes', async field => {
    const f = await pending(); const key = resourceGuardKey(f.m.resources[0]!.markerId);
    const guard = JSON.parse((await redis.get(key))!) as { incarnation: string; epoch: number; resource: { generation: number; productId: string } };
    if (field === 'productId') guard.resource.productId = randomUUID();
    else if (field === 'generation') guard.resource.generation++;
    else if (field === 'epoch') guard.epoch++;
    else guard.incarnation = randomUUID();
    await redis.set(key, JSON.stringify(guard));
    const before = await redis.get(reservationKey(f.cartId, f.productId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(before);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
  });
  it.each(['replayId', 'action', 'identity'] as const)('incorrect receipt %s never acknowledges or repeats mutation', async field => {
    const f = await pending(); const key = settlementReceiptKey(f.m.id);
    const receipt = { identity: settlementOwnershipIdentity(f.m), action: 'CHECKOUT_FINALIZE',
      replayId: f.m.settlementReplayId, complete: true };
    receipt[field] = randomUUID(); await redis.set(key, JSON.stringify(receipt));
    const before = await redis.get(reservationKey(f.cartId, f.productId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(before);
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', completionReceiptHash: null });
  });
  it.each(['holdInstanceId', 'generation', 'checkoutOperationId', 'checkoutAttemptId', 'reservationExecutionEpoch',
    'quantity', 'customerId', 'cartId', 'markerId', 'checkoutIdempotencyKey', 'status'] as const)('wrong %s rejects all writes and preserves terminal identity', async field => {
    const f = await pending(); const key = reservationKey(f.cartId, f.productId);
    const entry = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    entry[field] = typeof entry[field] === 'number' ? Number(entry[field]) + 1 : randomUUID();
    await redis.set(key, JSON.stringify(entry), 'KEEPTTL');
    const before = await redis.get(key), pin = await redis.get(checkoutPinKey(f.m.resources[0]!.markerId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    expect(await redis.get(key)).toBe(before); expect(await redis.get(checkoutPinKey(f.m.resources[0]!.markerId))).toBe(pin);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', settlementReplayId: f.m.settlementReplayId });
  });
  it('missing pin denies W6; a forged completion object cannot acknowledge SETTLED', async () => {
    const f = await pending(); await redis.del(checkoutPinKey(f.m.resources[0]!.markerId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_REJECTED' });
    await expect(schema.prisma.$transaction(tx => repo.acknowledgeSettled(tx, f.m.id, {} as SettlementCompletionEvidence)))
      .rejects.toThrow('SETTLEMENT_COMPLETION_EVIDENCE_REQUIRED');
    await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow();
  });
  it('lost response after execution resolves on a fresh service without repeating W6', async () => {
    const f = await pending(); const original = adapter.eval.bind(adapter);
    const loss = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT) throw new Error('Lost W6 response');
      return result;
    });
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'FINALIZE_UNCERTAIN' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', settlementReplayId: f.m.settlementReplayId });
    loss.mockRestore(); const execute = jest.spyOn(adapter, 'eval');
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_FINALIZE_SCRIPT)).toHaveLength(0);
  });
  it('unrelated cart resource and cart-index membership remain untouched', async () => {
    const f = await pending(); const other = randomUUID(); const key = reservationKey(f.cartId, other);
    keys.add(key); await redis.set(key, 'unrelated'); await redis.sadd(cartIndexKey(f.cartId), other);
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(await redis.get(key)).toBe('unrelated'); expect(await redis.sismember(cartIndexKey(f.cartId), other)).toBe(1);
  });
  it('accounting underflow deletes the exact hold and marks suspect without clamping the total', async () => {
    const f = await pending(); await redis.set(productTotalKey(f.productId), '1');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(await redis.get(productTotalKey(f.productId))).toBe('1');
    expect(await redis.get(productSuspectKey(f.productId))).toBe('1');
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBeNull();
  });
  it.each(['OPEN', 'DRAINING', 'FROZEN', 'RETIRED'] as const)('W6 phase policy in %s', async phase => {
    const f = await pending();
    const setPhase = async (next: typeof phase) => {
      const previous = await schema.prisma.reservationFenceTransition.findFirstOrThrow({ orderBy: { revision: 'desc' } });
      const row = await schema.prisma.$transaction(async tx => {
      const mode = await tx.reservationEngineModeConfig.create({ data: {
        mode: next === 'OPEN' ? 'CART_SCOPED' : next === 'RETIRED' ? 'LEGACY' : 'DRAINING', updatedById: f.customerId } });
      return tx.reservationFenceTransition.create({ data: { incarnation: previous.incarnation,
        epoch: previous.epoch, revision: previous.revision + 1, phase: next, protocol: 1, status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(), mode: mode.mode, modeRevision: mode.revision,
        reason: next === 'OPEN' ? 'OPEN' : next === 'RETIRED' ? 'RETIRE' : 'RESTRICT', actorId: randomUUID() } });
      });
      await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(row)));
    };
    try {
      await setPhase(phase);
      const result = await service.continue(f.customerId, f.op.id);
      if (phase === 'OPEN' || phase === 'DRAINING') expect(result).toEqual({ code: 'SETTLED' });
      else {
        expect(result).toEqual({ code: 'FINALIZE_REJECTED' });
        expect(await redis.get(reservationKey(f.cartId, f.productId))).not.toBeNull();
        expect(await redis.get(checkoutPinKey(f.m.resources[0]!.markerId))).toBe(settlementOwnershipIdentity(f.m));
        expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
      }
    } finally { await setPhase('OPEN'); }
  });
});
