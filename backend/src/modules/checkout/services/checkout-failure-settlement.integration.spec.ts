import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { OrderWithDetails } from '../../orders/repositories/orders.repository';
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
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { cartIndexKey, reservationKey, productTotalKey, productSuspectKey } from '../../inventory/constants/inventory.constants';
import { connectRealRedis, cleanupKeys, trackKeysFor } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { openAcquisitionSchema, seedCanonicalOrdinaryOwnership } from './checkout-acquisition-test-helpers';
import { buildRealCoordinator, seedReadyCheckout, setUpCheckoutIntegrationFixture } from './checkout-coordinator-integration-test-helpers';
import { CheckoutAcquisitionService } from './checkout-acquisition.service';
import { CheckoutFailureSettlementService } from './checkout-failure-settlement.service';

describe('G.4b.2c.3 durable failure and exact physical W5', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openAcquisitionSchema>>;
  let redis: Awaited<ReturnType<typeof connectRealRedis>>;
  let fixture: Awaited<ReturnType<typeof setUpCheckoutIntegrationFixture>>;
  let handles: ReturnType<typeof buildRealCoordinator>;
  let fences: ReservationFenceRepository, repo: CheckoutSettlementRepository;
  let adapter: RedisService, authority: CheckoutSettlementAuthorityService;
  let acquisition: CheckoutAcquisitionService, service: CheckoutFailureSettlementService;
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
  function fresh() { return new CheckoutFailureSettlementService(schema.prisma, adapter,
    new CheckoutAttemptRepository(schema.prisma), repo, fences, authority); }
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
    for (const key of await seedCanonicalOrdinaryOwnership(schema.prisma, redis, f.cartId, f.customerId)) keys.add(key);
    const m = await repo.prepare(op.id, attempt.id, f.customerId);
    return { ...f, op, attempt, m };
  }
  async function acquired(twoResources = false) {
    const f = await prepared(twoResources); const result = await acquisition.acquire(f.customerId, f.op.id);
    if (!result.ok) throw new Error('Fixture acquisition failed');
    return { ...f, evidence: result.evidence };
  }
  const abort = () => Promise.reject(new Error('Order callback aborted'));
  async function pending(twoResources = false) {
    const f = await acquired(twoResources);
    const original = adapter.eval.bind(adapter);
    const loss = jest.spyOn(adapter, 'eval').mockImplementation((...args) => args[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT
      ? Promise.reject(new Error('Before W5 transport loss')) : original(...args));
    expect(await service.runOrder(f.evidence, abort)).toEqual({ kind: 'FAILED', settlement: { code: 'REVERT_UNCERTAIN' } });
    loss.mockRestore();
    const m = (await repo.find(f.m.id))!;
    expect(m).toMatchObject({ state: 'REVERT_PENDING', effect: 'CHECKOUT_REVERT_DELETE_ONLY', attempt: { status: 'FAILED', orderId: null } });
    expect(m.settlementReplayId).not.toBeNull(); expect(m.settlementReplayId).not.toBe(m.acquisitionReplayId);
    return { ...f, m };
  }
  it('rollback locks prove failure and atomically bind FAILED plus REVERT_PENDING before physical W5', async () => {
    const f = await pending();
    const before = await redis.get(productTotalKey(f.productId));
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'SETTLED', settlementReplayId: f.m.settlementReplayId });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBeNull();
    expect(await redis.get(checkoutPinKey(f.m.resources[0]!.markerId))).toBeNull();
    expect(Number(await redis.get(productTotalKey(f.productId)))).toBe(Number(before) - f.quantity);
    expect(JSON.parse((await redis.get(settlementReceiptKey(f.m.id)))!)).toEqual({ identity: settlementOwnershipIdentity(f.m),
      action: 'CHECKOUT_REVERT_DELETE_ONLY', replayId: f.m.settlementReplayId, complete: true });
    const execute = jest.spyOn(adapter, 'eval');
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
  });
  it('failure-intent write error rolls back FAILED and never executes W5', async () => {
    const f = await acquired();
    jest.spyOn(repo, 'markRevertPending').mockRejectedValueOnce(new Error('Intent failure'));
    const execute = jest.spyOn(adapter, 'eval');
    expect(await service.runOrder(f.evidence, abort)).toEqual({ kind: 'UNRESOLVED' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'ACQUIRED', settlementReplayId: null, attempt: { status: 'PROCESSING' } });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
  });
  it('a conflict in the second resource leaves every reservation and pin unchanged', async () => {
    const f = await pending(true); expect(f.m.resources).toHaveLength(2);
    const second = f.m.resources[1]!; const key = reservationKey(f.cartId, second.productId);
    const entry = JSON.parse((await redis.get(key))!) as { quantity: number }; entry.quantity++;
    await redis.set(key, JSON.stringify(entry), 'KEEPTTL');
    const before = await Promise.all(f.m.resources.map(r => redis.get(reservationKey(f.cartId, r.productId))));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    expect(await Promise.all(f.m.resources.map(r => redis.get(reservationKey(f.cartId, r.productId))))).toEqual(before);
    for (const r of f.m.resources) expect(await redis.get(checkoutPinKey(r.markerId))).toBe(settlementOwnershipIdentity(f.m));
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
  });
  it('concurrent rollback resolution selects terminal identity once and cleanup decrements once', async () => {
    const f = await acquired(); const select = jest.spyOn(repo, 'markRevertPending');
    const before = Number(await redis.get(productTotalKey(f.productId)));
    const results = await Promise.all([service.runOrder(f.evidence, abort), fresh().runOrder(f.evidence, abort)]);
    expect(results).toEqual([{ kind: 'FAILED', settlement: { code: 'SETTLED' } },
      { kind: 'FAILED', settlement: { code: 'SETTLED' } }]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(Number(await redis.get(productTotalKey(f.productId)))).toBe(before - f.quantity);
    const m = (await repo.find(f.m.id))!;
    expect(m.settlementReplayId).not.toBe(m.acquisitionReplayId);
    expect(m.state).toBe('SETTLED');
  });
  it('ambiguous transaction rejection without callback rollback proof preserves PROCESSING and ACQUIRED', async () => {
    const f = await acquired();
    jest.spyOn(schema.prisma, '$transaction').mockRejectedValueOnce(new Error('Lost transaction response'));
    const execute = jest.spyOn(adapter, 'eval');
    expect(await service.runOrder(f.evidence, abort)).toEqual({ kind: 'UNRESOLVED' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'ACQUIRED', settlementReplayId: null, attempt: { status: 'PROCESSING' } });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
  });
  it('historical COMMITTED plus ACQUIRED is unresolved and never executes W5/W6', async () => {
    const f = await acquired();
    const order = await schema.prisma.order.create({ data: { customerId: f.customerId,
      deliveryAddressLine1: 'Fixture', deliveryParish: 'KINGSTON', deliveryPhone: '000', currency: 'JMD' } });
    await schema.prisma.$transaction(tx => new CheckoutAttemptRepository(schema.prisma)
      .markCommitted(tx, f.attempt.id, f.customerId, order.id, new Date()));
    const execute = jest.spyOn(adapter, 'eval'); const work = jest.fn(abort);
    expect(await service.runOrder(f.evidence, work)).toEqual({ kind: 'UNRESOLVED' });
    expect(work).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'ACQUIRED', settlementReplayId: null, effect: null });
  });
  it('PREPARED and missing manifest cannot be converted to failure by restart continuation', async () => {
    const f = await prepared(); const execute = jest.spyOn(adapter, 'eval');
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    expect(await service.continue(f.customerId, randomUUID())).toEqual({ code: 'REVERT_REJECTED' });
    expect(execute).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'PREPARED', settlementReplayId: null, attempt: { status: 'PROCESSING' } });
  });
  it('lost COMMIT response is resolved from the actual committed order without failure settlement', async () => {
    const f = await acquired();
    const transact = schema.prisma.$transaction.bind(schema.prisma);
    jest.spyOn(schema.prisma, '$transaction').mockImplementationOnce(async work => {
      await transact(work as (tx: Prisma.TransactionClient) => Promise<OrderWithDetails>);
      throw new Error('COMMIT response lost');
    });
    const execute = jest.spyOn(adapter, 'eval');
    const result = await service.runOrder(f.evidence, async tx => {
      const order = await tx.order.create({ data: { customerId: f.customerId,
        deliveryAddressLine1: 'Fixture', deliveryParish: 'KINGSTON', deliveryPhone: '000', currency: 'JMD' } });
      expect(await new CheckoutAttemptRepository(schema.prisma).markCommitted(tx, f.attempt.id, f.customerId, order.id, new Date()))
        .toEqual({ count: 1 });
      return order as unknown as OrderWithDetails;
    });
    expect(result).toMatchObject({ kind: 'COMMITTED', attemptId: f.attempt.id });
    expect(execute).not.toHaveBeenCalled();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'FINALIZE_PENDING', effect: 'CHECKOUT_FINALIZE',
      attempt: { status: 'COMMITTED' } });
    expect((await repo.find(f.m.id))!.settlementReplayId).not.toBeNull();
  });
  it('actual partial order writes are rolled back before failure intent is durably selected', async () => {
    const f = await acquired();
    expect(await service.runOrder(f.evidence, async tx => {
      await tx.order.create({ data: { customerId: f.customerId, deliveryAddressLine1: 'Fixture',
        deliveryParish: 'KINGSTON', deliveryPhone: '000', currency: 'JMD' } });
      throw new Error('Abort after partial order writes');
    })).toEqual({ kind: 'FAILED', settlement: { code: 'SETTLED' } });
    expect(await schema.prisma.order.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'SETTLED', attempt: { status: 'FAILED', orderId: null } });
  });
  it.each(['incarnation', 'epoch', 'generation'] as const)('wrong guard %s rejects without physical writes', async field => {
    const f = await pending(); const key = resourceGuardKey(f.m.resources[0]!.markerId);
    const guard = JSON.parse((await redis.get(key))!) as { incarnation: string; epoch: number; resource: { generation: number } };
    if (field === 'generation') guard.resource.generation++;
    else if (field === 'epoch') guard.epoch++;
    else guard.incarnation = randomUUID();
    await redis.set(key, JSON.stringify(guard));
    const before = await redis.get(reservationKey(f.cartId, f.productId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(before);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
  });
  it.each(['replayId', 'action', 'identity'] as const)('incorrect receipt %s never acknowledges or repeats mutation', async field => {
    const f = await pending(); const key = settlementReceiptKey(f.m.id);
    const receipt = { identity: settlementOwnershipIdentity(f.m), action: 'CHECKOUT_REVERT_DELETE_ONLY',
      replayId: f.m.settlementReplayId, complete: true };
    receipt[field] = randomUUID(); await redis.set(key, JSON.stringify(receipt));
    const before = await redis.get(reservationKey(f.cartId, f.productId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(before);
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'REVERT_PENDING', completionReceiptHash: null });
  });
  it.each(['holdInstanceId', 'generation', 'checkoutOperationId', 'checkoutAttemptId', 'reservationExecutionEpoch',
    'quantity', 'customerId', 'cartId', 'markerId'] as const)('wrong %s rejects all writes and preserves terminal identity', async field => {
    const f = await pending(); const key = reservationKey(f.cartId, f.productId);
    const entry = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
    entry[field] = typeof entry[field] === 'number' ? Number(entry[field]) + 1 : randomUUID();
    await redis.set(key, JSON.stringify(entry), 'KEEPTTL');
    const before = await redis.get(key), pin = await redis.get(checkoutPinKey(f.m.resources[0]!.markerId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    expect(await redis.get(key)).toBe(before); expect(await redis.get(checkoutPinKey(f.m.resources[0]!.markerId))).toBe(pin);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'REVERT_PENDING', settlementReplayId: f.m.settlementReplayId });
  });
  it('missing pin denies W5; a forged completion object cannot acknowledge SETTLED', async () => {
    const f = await pending(); await redis.del(checkoutPinKey(f.m.resources[0]!.markerId));
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_REJECTED' });
    await expect(schema.prisma.$transaction(tx => repo.acknowledgeSettled(tx, f.m.id, {} as SettlementCompletionEvidence)))
      .rejects.toThrow('SETTLEMENT_COMPLETION_EVIDENCE_REQUIRED');
    await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow();
  });
  it('lost response after execution resolves on a fresh service without repeating W5', async () => {
    const f = await pending(); const original = adapter.eval.bind(adapter);
    const loss = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT) throw new Error('Lost W5 response');
      return result;
    });
    expect(await service.continue(f.customerId, f.op.id)).toEqual({ code: 'REVERT_UNCERTAIN' });
    expect(await repo.find(f.m.id)).toMatchObject({ state: 'REVERT_PENDING', settlementReplayId: f.m.settlementReplayId });
    loss.mockRestore(); const execute = jest.spyOn(adapter, 'eval');
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect(execute.mock.calls.filter(c => c[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
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
  it('one residual old owner prevents completion of a multi-resource receipt', async () => {
    const f = await pending(true);
    await redis.set(settlementReceiptKey(f.m.id), JSON.stringify({ identity: settlementOwnershipIdentity(f.m),
      action: 'CHECKOUT_REVERT_DELETE_ONLY', replayId: f.m.settlementReplayId, complete: true }));
    for (const resource of f.m.resources) await redis.del(checkoutPinKey(resource.markerId));
    await redis.del(reservationKey(f.cartId, f.m.resources[0]!.productId));
    const remainingKey = reservationKey(f.cartId, f.m.resources[1]!.productId);
    const before = await redis.get(remainingKey);
    await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
    expect(await redis.get(remainingKey)).toBe(before);
    expect((await repo.find(f.m.id))?.completionReceiptHash).toBeNull();
  });

  it.each(['checkoutOperationId', 'checkoutAttemptId', 'checkoutIdempotencyKey'] as const)(
    'old owner component %s rejects despite a different hold ID and missing pin', async field => {
      const f = await pending(); const resource = f.m.resources[0]!;
      const key = reservationKey(f.cartId, resource.productId);
      const original = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
      const entry: Record<string, unknown> = { ...original, holdInstanceId: randomUUID(), checkoutOperationId: randomUUID(),
        checkoutAttemptId: randomUUID(), checkoutIdempotencyKey: randomUUID() };
      entry[field] = original[field];
      await redis.set(key, JSON.stringify(entry));
      await redis.del(checkoutPinKey(resource.markerId));
      await redis.set(settlementReceiptKey(f.m.id), JSON.stringify({ identity: settlementOwnershipIdentity(f.m),
        action: 'CHECKOUT_REVERT_DELETE_ONLY', replayId: f.m.settlementReplayId, complete: true }));
      await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
      expect((await repo.find(f.m.id))?.completionReceiptHash).toBeNull();
    });

  it.each(['active', 'later-owner', 'missing-receipt', 'missing-acquisition', 'mismatched-pin', 'malformed-entry'] as const)(
    'same-ID %s observation fails closed without rewriting later state', async kind => {
      const f = await pending(); const resource = f.m.resources[0]!;
      const key = reservationKey(f.cartId, resource.productId);
      const entry = JSON.parse((await redis.get(key))!) as Record<string, unknown>;
      const grant = await authority.register(f.m.id, 'CHECKOUT_REVERT_DELETE_ONLY');
      expect(JSON.parse(await adapter.eval(CHECKOUT_SETTLEMENT_REVERT_SCRIPT,
        [RESERVATION_FENCE_KEY, grant.key], []) as string)).toMatchObject({ code: 'ACCEPTED' });
      // Synthetic later ownership observation only: global hold uniqueness and
      // canonical W4 capture are intentionally not changed by this slice.
      const operationId = randomUUID(), attemptId = randomUUID(), manifestId = randomUUID();
      const later = { ...f.m, id: manifestId, operationId, attemptId, acquisitionReplayId: randomUUID(),
        operation: { ...f.m.operation, id: operationId, operationKey: randomUUID() } };
      const identity = settlementOwnershipIdentity(later);
      const pinKey = checkoutPinKey(resource.markerId);
      const acquisitionKey = `reservation:fence:settlement-acquisition:${manifestId}`;
      keys.add(acquisitionKey);
      await redis.set(key, JSON.stringify({ ...entry, checkoutOperationId: operationId,
        checkoutAttemptId: attemptId, checkoutIdempotencyKey: later.operation.operationKey }));
      await redis.set(pinKey, identity);
      await redis.set(acquisitionKey, JSON.stringify({ identity, replayId: later.acquisitionReplayId }));
      if (kind === 'active') {
        await redis.del(pinKey);
        await redis.set(key, JSON.stringify({ ...entry, status: 'ACTIVE', checkoutOperationId: null,
          checkoutAttemptId: null, checkoutIdempotencyKey: null, checkoutPendingAt: null, checkoutPendingExpiresAt: null }));
      }
      if (kind === 'missing-receipt') await redis.del(settlementReceiptKey(f.m.id));
      if (kind === 'missing-acquisition') await redis.del(acquisitionKey);
      if (kind === 'mismatched-pin') await redis.set(pinKey, '{}');
      if (kind === 'malformed-entry') await redis.set(key, '{}');
      const observedKeys = [key, pinKey, acquisitionKey, resourceGuardKey(resource.markerId),
        productTotalKey(resource.productId), settlementReceiptKey(f.m.id)];
      const before = await redis.mget(...observedKeys);
      await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
      await fresh().continue(f.customerId, f.op.id);
      expect((await repo.find(f.m.id))?.completionReceiptHash).toBeNull();
      expect(await redis.mget(...observedKeys)).toEqual(before);
    });

  async function laterOwner(f: Awaited<ReturnType<typeof pending>>, quantityDelta = 0) {
    const entries = await Promise.all(f.m.resources.map(async r =>
      JSON.parse((await redis.get(reservationKey(f.cartId, r.productId)))!) as Record<string, unknown>));
    const grant = await authority.register(f.m.id, 'CHECKOUT_REVERT_DELETE_ONLY');
    const execute = () => adapter.eval(CHECKOUT_SETTLEMENT_REVERT_SCRIPT, [RESERVATION_FENCE_KEY, grant.key], []);
    expect(JSON.parse(await execute() as string)).toMatchObject({ code: 'ACCEPTED' });
    const receiptBytes = await redis.get(settlementReceiptKey(f.m.id));
    // The original physical settlement is real. Later ownership is a synthetic
    // Redis evidence fixture: global SQL uniqueness/canonical W4 remain deferred.
    const operationId = randomUUID(), attemptId = randomUUID(), manifestId = randomUUID();
    const later = { ...f.m, id: manifestId, operationId, attemptId, acquisitionReplayId: randomUUID(),
      resources: f.m.resources.map(r => ({ ...r, quantity: r.quantity + quantityDelta })),
      operation: { ...f.m.operation, id: operationId, operationKey: randomUUID() } };
    const identity = settlementOwnershipIdentity(later);
    const acquisitionKey = `reservation:fence:settlement-acquisition:${manifestId}`;
    keys.add(acquisitionKey);
    const record: Record<string, unknown> = { version: 2, identity, replayId: later.acquisitionReplayId,
      checkoutIdempotencyKey: later.operation.operationKey };
    const observedKeys = [acquisitionKey, settlementReceiptKey(f.m.id), cartIndexKey(f.cartId)];
    for (const [i, r] of f.m.resources.entries()) {
      entries[i] = { ...entries[i], quantity: later.resources[i]!.quantity, checkoutOperationId: operationId, checkoutAttemptId: attemptId,
        checkoutIdempotencyKey: later.operation.operationKey };
      const entryKey = reservationKey(f.cartId, r.productId);
      const productIndex = `inv:reserved:product-index:{${r.productId}}`;
      await redis.set(entryKey, JSON.stringify(entries[i]));
      await redis.set(checkoutPinKey(r.markerId), identity);
      await redis.sadd(cartIndexKey(f.cartId), r.productId); await redis.sadd(productIndex, f.cartId);
      await redis.incrby(productTotalKey(r.productId), later.resources[i]!.quantity);
      observedKeys.push(entryKey, checkoutPinKey(r.markerId), resourceGuardKey(r.markerId),
        productIndex, productTotalKey(r.productId), productSuspectKey(r.productId));
    }
    await redis.set(acquisitionKey, JSON.stringify(record));
    const snapshot = () => Promise.all(observedKeys.map(async key => (await redis.type(key)) === 'set'
      ? (await redis.smembers(key)).sort() : redis.get(key)));
    return { later, identity, record, acquisitionKey, entries, snapshot, execute, receiptBytes };
  }

  it.each([0, 1])('V2 later owner with quantity delta %i survives old replay, lost-response acknowledgement and SETTLED re-read', async quantityDelta => {
    const f = await pending(true); const next = await laterOwner(f, quantityDelta);
    for (const [i, resource] of f.m.resources.entries()) {
      expect(next.later.resources[i]).toEqual({ ...resource, quantity: resource.quantity + quantityDelta });
      expect(next.entries[i]!.quantity).toBe(resource.quantity + quantityDelta);
    }
    const before = await next.snapshot();
    expect(JSON.parse(await next.execute() as string)).toMatchObject({ code: 'ACCEPTED', value: { replayed: true } });
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    const settled = (await repo.find(f.m.id))!;
    expect(settled.completionReceiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await fresh().continue(f.customerId, f.op.id)).toEqual({ code: 'SETTLED' });
    expect((await repo.find(f.m.id))?.completionReceiptHash).toBe(settled.completionReceiptHash);
    expect(await redis.get(settlementReceiptKey(f.m.id))).toBe(next.receiptBytes);
    expect(await next.snapshot()).toEqual(before);
  });

  it.each(['live-key', 'acquisition-key', 'identity', 'replay', 'version', 'partial', 'unversioned-extra',
    'legacy', 'missing-acquisition', 'missing-pin', 'mismatched-pin', 'missing-guard', 'guard-epoch',
    'old-operation', 'old-attempt', 'old-key', 'active', 'quantity', 'marker', 'generation',
    'manifest', 'acquisition-replay', 'pin-operation', 'missing-receipt'] as const)(
    'V2 later-owner contradiction %s fails closed with zero writes', async fault => {
      const f = await pending(true); const next = await laterOwner(f);
      const r = f.m.resources[1]!; const entry = next.entries[1]!;
      if (fault === 'live-key') entry.checkoutIdempotencyKey = randomUUID();
      if (fault === 'old-operation') entry.checkoutOperationId = f.m.operationId;
      if (fault === 'old-attempt') entry.checkoutAttemptId = f.m.attemptId;
      if (fault === 'old-key') entry.checkoutIdempotencyKey = f.m.operation.operationKey;
      if (fault === 'active') entry.status = 'ACTIVE';
      if (fault === 'quantity') entry.quantity = r.quantity + 1;
      if (fault === 'marker') entry.markerId = randomUUID();
      if (fault === 'generation') entry.generation = r.generation + 1;
      await redis.set(reservationKey(f.cartId, r.productId), JSON.stringify(entry));
      if (fault === 'acquisition-key') next.record.checkoutIdempotencyKey = randomUUID();
      if (fault === 'identity') next.record.identity = '{}';
      if (fault === 'replay') next.record.replayId = randomUUID();
      if (fault === 'version') next.record.version = 3;
      if (fault === 'partial') delete next.record.checkoutIdempotencyKey;
      if (fault === 'unversioned-extra' || fault === 'legacy') delete next.record.version;
      if (fault === 'legacy') delete next.record.checkoutIdempotencyKey;
      await redis.set(next.acquisitionKey, JSON.stringify(next.record));
      if (fault === 'missing-acquisition') await redis.del(next.acquisitionKey);
      if (fault === 'missing-pin') await redis.del(checkoutPinKey(r.markerId));
      if (fault === 'mismatched-pin') await redis.set(checkoutPinKey(r.markerId), '{}');
      if (fault === 'manifest' || fault === 'acquisition-replay' || fault === 'pin-operation') {
        const pin = JSON.parse(next.identity) as { manifestId: string; acquisitionReplayId: string; execution: { operationId: string } };
        if (fault === 'manifest') pin.manifestId = f.m.id;
        if (fault === 'acquisition-replay') pin.acquisitionReplayId = f.m.acquisitionReplayId;
        if (fault === 'pin-operation') pin.execution.operationId = randomUUID();
        await redis.set(checkoutPinKey(r.markerId), JSON.stringify(pin));
      }
      if (fault === 'missing-guard') await redis.del(resourceGuardKey(r.markerId));
      if (fault === 'guard-epoch') {
        const guard = JSON.parse((await redis.get(resourceGuardKey(r.markerId)))!) as Record<string, unknown>;
        await redis.set(resourceGuardKey(r.markerId), JSON.stringify({ ...guard, epoch: 99 }));
      }
      if (fault === 'missing-receipt') await redis.del(settlementReceiptKey(f.m.id));
      const before = await next.snapshot();
      await expect(readSettlementCompletion(adapter, f.m)).rejects.toThrow('SETTLEMENT_COMPLETION_UNRESOLVED');
      await fresh().continue(f.customerId, f.op.id);
      expect((await repo.find(f.m.id))?.completionReceiptHash).toBeNull();
      expect(await next.snapshot()).toEqual(before);
    });

  it.each(['OPEN', 'DRAINING', 'FROZEN', 'RETIRED'] as const)('W5 phase policy in %s', async phase => {
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
        expect(result).toEqual({ code: 'REVERT_REJECTED' });
        expect(await redis.get(reservationKey(f.cartId, f.productId))).not.toBeNull();
        expect(await redis.get(checkoutPinKey(f.m.resources[0]!.markerId))).toBe(settlementOwnershipIdentity(f.m));
        expect(await redis.get(settlementReceiptKey(f.m.id))).toBeNull();
      }
    } finally { await setPhase('OPEN'); }
  });
});
