import { CheckoutFinalizeSettlementService } from '../../checkout/services/checkout-finalize-settlement.service';
import { CheckoutFailureSettlementService } from '../../checkout/services/checkout-failure-settlement.service';
import { CHECKOUT_SETTLEMENT_REVERT_SCRIPT } from '../../inventory/lua/checkout-settlement-revert-lua-scripts';
import { randomUUID } from 'crypto';
import { RedisService } from '../../../common/redis/redis.service';
import { CheckoutAcquisitionService } from '../../checkout/services/checkout-acquisition.service';
import { openAcquisitionSchema, seedCanonicalOrdinaryOwnership } from '../../checkout/services/checkout-acquisition-test-helpers';
import { ReservationFenceRepository, transitionTuple } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { CheckoutSettlementAuthorityService } from '../../reservation-fence/services/checkout-settlement-authority.service';
import { ReservationMutationAuthorityService } from '../../reservation-fence/services/reservation-mutation-authority.service';
import { RESERVATION_FENCE_KEY } from '../../reservation-fence/lua/reservation-fence-control.lua';
import { MUTATION_HISTORY_KEY, executionGateKey, resourceGuardKey } from '../../reservation-fence/lua/reservation-mutation-common.lua';
import { checkoutPinKey } from '../../reservation-fence/lua/checkout-settlement.lua';
import { CHECKOUT_ACQUIRE_SCRIPT } from '../../inventory/lua/checkout-acquire-lua-scripts';
import { cartIndexKey, reservationKey } from '../../inventory/constants/inventory.constants';
import { settlementOwnershipIdentity } from '../../reservation-fence/services/checkout-settlement-evidence';
import { withCleanup } from '../../checkout-rollback/tests/rollback-evidence-test-helpers';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutDispatchService } from './checkout-dispatch.service';
import { AtomicCheckoutAdmissionService } from './atomic-checkout-admission.service';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutOperationService } from '../../checkout-operation/services/checkout-operation.service';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PRICE_LOCK_TTL_SECONDS } from '../../price-lock/constants/price-lock.constants';
import { CheckoutShadowComparisonService } from '../../checkout-shadow/services/checkout-shadow-comparison.service';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from '../../checkout-rollout/services/checkout-rollout-participants.service';
import {
  connectRealRedis,
  cleanupKeys,
  trackKeysFor,
} from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
} from '../../checkout/services/checkout-coordinator-integration-test-helpers';

describe('G.2b dispatch through the real coordinator (Postgres and Redis)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openAcquisitionSchema>>;
  let prisma: PrismaService;
  let redis: Awaited<ReturnType<typeof connectRealRedis>>;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;
  let operations: CheckoutOperationService;
  let dispatcher: CheckoutDispatchService;
  const keys = new Set<string>();
  let admission: AtomicCheckoutAdmissionService;
  let acquisition: CheckoutAcquisitionService;
  let adapter: RedisService;
  let manifests: CheckoutSettlementRepository;
  let metadata: ReservationMutationAuthorityService;
  let controls: RolloutControlsRepository;
  const shadow = { compare: jest.fn() };
  beforeAll(async () => {
    schema = await openAcquisitionSchema();
    prisma = schema.prisma;
    controls = new RolloutControlsRepository(prisma);
    await prisma.$connect();
    redis = await connectRealRedis();
    fixture = await setUpCheckoutIntegrationFixture(prisma);
    const mode = await prisma.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: fixture.userIds[0]! } });
    const fence = await prisma.reservationFenceTransition.create({ data: { incarnation: randomUUID(), epoch: 1,
      revision: 1, phase: 'OPEN', protocol: 1, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(),
      mode: 'CART_SCOPED', modeRevision: mode.revision, reason: 'OPEN', actorId: randomUUID() } });
    keys.add(RESERVATION_FENCE_KEY); keys.add(MUTATION_HISTORY_KEY);
    await redis.set(RESERVATION_FENCE_KEY, JSON.stringify(transitionTuple(fence)));
    await redis.hset(MUTATION_HISTORY_KEY, 'incarnation', fence.incarnation);
  });
  beforeEach(async () => {
    if (await controls.findCurrent()) throw new Error('Requires isolated global rollout controls');
    await controls.appendIfCurrent(fixture.userIds[0]!, {
      expectedRevision: null,
      newAdmissionStopped: false,
      behavior: 'CART_SCOPED',
      eligibleCohort: null,
      reason: 'Integration admission',
    });
    handles = buildRealCoordinator(prisma, redis);
    operations = new CheckoutOperationService(
      new CheckoutOperationRepository(prisma),
      handles.cartRepository,
      new PriceLockRepository(prisma),
      handles.priceLockService,
    );
    admission = new AtomicCheckoutAdmissionService(
      prisma,
      new CheckoutOperationRepository(prisma),
      new CheckoutAttemptRepository(prisma),
      controls,
      new CheckoutRolloutParticipantsRepository(prisma),
    );
    const fences = new ReservationFenceRepository(prisma);
    manifests = new CheckoutSettlementRepository(prisma, fences);
    adapter = new RedisService(redis);
    metadata = new ReservationMutationAuthorityService(fences, adapter);
    acquisition = new CheckoutAcquisitionService(prisma, adapter, manifests, fences,
      new CheckoutSettlementAuthorityService(manifests, fences, adapter), metadata);
    dispatcher = new CheckoutDispatchService(
      operations,
      handles.checkoutAttemptService,
      handles.coordinator,
      handles.ordersService,
      admission,
      shadow as unknown as CheckoutShadowComparisonService,
      acquisition,
      new CheckoutFailureSettlementService(prisma, adapter, new CheckoutAttemptRepository(prisma), manifests, fences,
        new CheckoutSettlementAuthorityService(manifests, fences, adapter)),
      new CheckoutFinalizeSettlementService(prisma, adapter, manifests, fences,
        new CheckoutSettlementAuthorityService(manifests, fences, adapter)),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.checkoutRolloutControlRevision.deleteMany({
      where: { actorId: fixture.userIds[0]! },
    });
  });
  afterAll(async () => {
    await withCleanup(async () => {
      if (prisma) for (const marker of await prisma.cartReservationSyncState.findMany()) keys.add(resourceGuardKey(marker.id));
      if (prisma) for (const m of await prisma.checkoutReservationSettlement.findMany({ include: { resources: true } })) {
        keys.add(executionGateKey(m.operationId)); keys.add("reservation:fence:settlement-receipt:" + m.id);
        keys.add(`reservation:fence:settlement-acquisition:${m.id}`);
        for (const r of m.resources) { keys.add(resourceGuardKey(r.markerId)); keys.add(checkoutPinKey(r.markerId)); }
      }
    }, [async () => { if (redis) await cleanupKeys(redis, keys); },
      async () => { if (redis) await redis.quit(); }, async () => { if (schema) await schema.close(); }]);
  });
  async function scenario() {
    const ready = await seedReadyCheckout(fixture, handles);
    const item = await handles.cartRepository.findItemByCartAndProduct(ready.cartId, ready.productId);
    await handles.syncStateRepository.upsertDesiredState(ready.cartId, ready.productId, item!.mutationVersion, ready.quantity);
    await new CheckoutRolloutParticipantsService(
      new CheckoutRolloutParticipantsRepository(prisma),
    ).setParticipation(ready.customerId, ready.customerId, {
      enabled: true,
      cohort: 'pilot',
      reason: 'Integration participant',
      expectedRevision: null,
    });
    for (const key of await seedCanonicalOrdinaryOwnership(prisma, redis, ready.cartId, ready.customerId)) keys.add(key);
    trackKeysFor(keys, ready.cartId, ready.productId);
    return { ...ready, retryKey: randomUUID(), dto: checkoutDto, now: new Date() };
  }
  it('issues/prepares/executes once, then replays COMMITTED after cart clearing and participant disable/lookup failure', async () => {
    const ready = await scenario();
    const input = {
      customerId: ready.customerId,
      cartId: ready.cartId,
      retryKey: ready.retryKey,
      dto: ready.dto,
      now: ready.now,
    };
    const pay = jest.spyOn(handles.paymentsService, 'initiatePayment');
    const rawMark = jest.spyOn(handles.checkoutReservationState, 'checkoutMark');
    const revert = jest.spyOn(handles.checkoutReservationRecovery, 'checkoutRevert');
    const finalize = jest.spyOn(handles.checkoutReservationRecovery, 'finalizeCheckoutConsumption');
    const markAcquired = jest.spyOn(manifests, 'markAcquired');
    const physicalEval = jest.spyOn(adapter, 'eval');
    const createOrder = jest.spyOn(handles.ordersService, 'createOrderInTransaction');
    const first = await dispatcher.checkout(input);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('First checkout failed');
    const operation = await prisma.checkoutOperation.findFirstOrThrow({
      where: { customerId: ready.customerId },
    });
    expect(operation.selectedPath).toBe('CART_SCOPED');
    expect(operation.priceLockFingerprint).not.toBeNull();
    expect(operation).toMatchObject({ reservationExecutionEpoch: 1, reservationCapabilityState: 'ACTIVE' });
    const manifest = await prisma.checkoutReservationSettlement.findFirstOrThrow({ where: { operationId: operation.id }, include: { resources: true } });
    expect(manifest).toMatchObject({ state: 'SETTLED', effect: 'CHECKOUT_FINALIZE' });
    expect(manifest.settlementReplayId).not.toBeNull();
    expect(manifest.settlementReplayId).not.toBe(manifest.acquisitionReplayId);
    expect(physicalEval.mock.calls.filter(call => call[0] === CHECKOUT_SETTLEMENT_REVERT_SCRIPT)).toHaveLength(0);
    expect(await redis.get(checkoutPinKey(manifest.resources[0]!.markerId))).toBeNull();
    expect(markAcquired.mock.invocationCallOrder[0]!).toBeLessThan(createOrder.mock.invocationCallOrder[0]!);
    const w4Call = physicalEval.mock.calls.findIndex(call => call[0] === CHECKOUT_ACQUIRE_SCRIPT);
    expect(w4Call).toBeGreaterThanOrEqual(0);
    expect(physicalEval.mock.invocationCallOrder[w4Call]!).toBeLessThan(markAcquired.mock.invocationCallOrder[0]!);
    expect(rawMark).not.toHaveBeenCalled(); expect(revert).not.toHaveBeenCalled(); expect(finalize).not.toHaveBeenCalled();
    expect(
      await prisma.checkoutAttempt.findUnique({
        where: { idempotencyKey: operation.operationKey },
      }),
    ).toMatchObject({ status: 'COMMITTED', selectedPath: 'CART_SCOPED', orderId: first.order.id });
    expect(await prisma.cartItem.count({ where: { cartId: ready.cartId } })).toBe(0);
    const administration = new CheckoutRolloutParticipantsService(
      new CheckoutRolloutParticipantsRepository(prisma),
    );
    await administration.setParticipation(ready.customerId, ready.customerId, {
      enabled: false,
      cohort: 'changed',
      reason: 'fixture disable',
      expectedRevision: 1,
    });
    await controls.appendIfCurrent(fixture.userIds[0]!, {
      expectedRevision: 1,
      newAdmissionStopped: true,
      behavior: 'DENY',
      eligibleCohort: null,
      reason: 'Stop after commit',
    });
    const admit = jest.spyOn(admission, 'admit').mockRejectedValue(new Error('lookup unavailable'));
    const prepare = jest
      .spyOn(operations, 'prepare')
      .mockRejectedValue(new Error('cleared cart must not be prepared'));
    const execute = jest.spyOn(handles.coordinator, 'checkoutAcquired');
    expect(await dispatcher.checkout(input)).toEqual({ ok: true, order: first.order });
    expect(admit).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await prisma.checkoutOperation.count({ where: { customerId: ready.customerId } })).toBe(
      1,
    );
    expect(await prisma.checkoutAttempt.count({ where: { customerId: ready.customerId } })).toBe(1);
    expect(await prisma.order.count({ where: { customerId: ready.customerId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: first.order.id } })).toBe(1);
    expect(pay).toHaveBeenCalledTimes(1);
  });
  it.each(['expiry', 'quantity'] as const)(
    'bound %s changes require reconfirmation before coordinator execution',
    async (change) => {
      const ready = await scenario();
      const issued = await operations.issue({
        customerId: ready.customerId,
        cartId: ready.cartId,
        retryKey: ready.retryKey,
      });
      if (!issued.ok) throw new Error('Issue failed');
      expect(await admission.admit({ customerId: ready.customerId, cartId: ready.cartId, operationId: issued.operation.id }))
        .toMatchObject({ ok: true, decision: 'CART_SCOPED' });
      const bound = await operations.prepare(ready.customerId, issued.operation.id, ready.now);
      expect(bound.ok).toBe(true);
      if (change === 'quantity') {
        const item = await handles.cartRepository.findItemByCartAndProduct(
          ready.cartId,
          ready.productId,
        );
        await handles.cartRepository.updateItemQuantity(item!.id, 3);
      }
      const before = await prisma.cartItem.findMany({ where: { cartId: ready.cartId } });
      const execute = jest.spyOn(handles.coordinator, 'checkoutAcquired');
      expect(
        await dispatcher.checkout({
          customerId: ready.customerId,
          cartId: ready.cartId,
          retryKey: ready.retryKey,
          dto: ready.dto,
          now:
            change === 'expiry'
              ? new Date(ready.now.getTime() + PRICE_LOCK_TTL_SECONDS * 1000)
              : ready.now,
        }),
      ).toEqual({ ok: false, code: 'RECONFIRM_REQUIRED' });
      expect(execute).not.toHaveBeenCalled();
      expect(await prisma.cartItem.findMany({ where: { cartId: ready.cartId } })).toEqual(before);
      expect(await prisma.checkoutAttempt.count({ where: { customerId: ready.customerId } })).toBe(
        1,
      );
    },
  );

  async function preparedAcquisition() {
    const ready = await scenario();
    const issued = await operations.issue({ customerId: ready.customerId, cartId: ready.cartId, retryKey: ready.retryKey });
    if (!issued.ok) throw new Error('Fixture operation failed');
    expect(await admission.admit({ customerId: ready.customerId, cartId: ready.cartId, operationId: issued.operation.id }))
      .toMatchObject({ ok: true, decision: 'CART_SCOPED' });
    const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { idempotencyKey: issued.operation.operationKey } });
    expect(attempt.reservationExecutionEpoch).toBe(1);
    const manifest = await manifests.prepare(issued.operation.id, attempt.id, ready.customerId);
    return { ...ready, operationId: issued.operation.id, attempt, manifest };
  }

  it('binds exact PG provenance, acquisition identity, pins and live entries before ACQUIRED; replay never marks again', async () => {
    const f = await preparedAcquisition();
    expect(f.manifest).toMatchObject({ state: 'PREPARED', settlementReplayId: null, sealed: true });
    const marker = await prisma.cartReservationSyncState.findFirstOrThrow({ where: { cartId: f.cartId } });
    expect(f.manifest.resources).toHaveLength(1);
    expect(f.manifest.resources[0]).toMatchObject({ markerId: marker.id, generation: marker.generation,
      productId: marker.productId, quantity: marker.expectedQuantity });
    const execute = jest.spyOn(adapter, 'eval');
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    const stored = await manifests.find(f.manifest.id);
    expect(stored).toMatchObject({ state: 'ACQUIRED', settlementReplayId: null, acquisitionReplayId: f.manifest.acquisitionReplayId });
    expect(await redis.get(checkoutPinKey(marker.id))).toBe(settlementOwnershipIdentity(f.manifest));
    expect(JSON.parse((await redis.get(`reservation:fence:settlement-acquisition:${f.manifest.id}`))!))
      .toEqual({ version: 2, identity: settlementOwnershipIdentity(f.manifest), replayId: f.manifest.acquisitionReplayId, checkoutIdempotencyKey: f.manifest.operation.operationKey });
    const physical = await redis.get(reservationKey(f.cartId, f.productId));
    expect(JSON.parse(physical!)).toMatchObject({ status: 'CHECKOUT_PENDING', holdInstanceId: f.manifest.resources[0]!.holdInstanceId,
      checkoutAttemptId: f.attempt.id, checkoutOperationId: f.operationId });
    execute.mockClear();
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    expect(execute.mock.calls.filter(call => call[0] === CHECKOUT_ACQUIRE_SCRIPT)).toHaveLength(0);
    expect(await redis.get(reservationKey(f.cartId, f.productId))).toBe(physical);
    expect(await prisma.checkoutReservationSettlement.count({ where: { attemptId: f.attempt.id } })).toBe(1);
    expect(await prisma.checkoutReservationResource.count({ where: { settlementId: f.manifest.id } })).toBe(1);
    expect(await prisma.order.count({ where: { customerId: f.customerId } })).toBe(0);
  });

  it('lost W4 response preserves PREPARED and a new orchestrator resolves the original acquisition without executing W4 again', async () => {
    const f = await preparedAcquisition();
    const original = adapter.eval.bind(adapter);
    const execution = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === CHECKOUT_ACQUIRE_SCRIPT) throw new Error('Injected response loss after physical execution');
      return result;
    });
    expect(await acquisition.acquire(f.customerId, f.operationId)).toEqual({ ok: false, code: 'ACQUISITION_UNCERTAIN' });
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'PREPARED', acquisitionReplayId: f.manifest.acquisitionReplayId, settlementReplayId: null });
    expect(await prisma.checkoutAttempt.findUnique({ where: { id: f.attempt.id } })).toMatchObject({ status: 'PROCESSING', failureCode: null });
    execution.mockRestore();
    const client = schema.newClient();
    try {
      const fences = new ReservationFenceRepository(client);
      const repo = new CheckoutSettlementRepository(client, fences);
      const freshAdapter = new RedisService(redis);
      const evalFresh = jest.spyOn(freshAdapter, 'eval');
      const fresh = new CheckoutAcquisitionService(client, freshAdapter, repo, fences,
        new CheckoutSettlementAuthorityService(repo, fences, freshAdapter), new ReservationMutationAuthorityService(fences, freshAdapter));
      expect(await fresh.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
      expect(evalFresh.mock.calls.filter(call => call[0] === CHECKOUT_ACQUIRE_SCRIPT)).toHaveLength(0);
      expect(await repo.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', acquisitionReplayId: f.manifest.acquisitionReplayId, settlementReplayId: null });
    } finally { await client.$disconnect(); }
  });

  it.each(['extra-index-member', 'ownership', 'quantity'] as const)('definite %s rejection performs zero reservation writes and never acknowledges acquisition', async kind => {
    const f = await preparedAcquisition();
    const key = reservationKey(f.cartId, f.productId);
    if (kind === 'extra-index-member') await redis.sadd(cartIndexKey(f.cartId), randomUUID());
    else {
      const entry = JSON.parse((await redis.get(key))!) as { customerId: string; quantity: number };
      if (kind === 'ownership') entry.customerId = randomUUID();
      else entry.quantity += 1;
      await redis.set(key, JSON.stringify(entry), 'KEEPTTL');
    }
    const before = await redis.get(key);
    const acknowledged = jest.spyOn(manifests, 'markAcquired');
    expect(await acquisition.acquire(f.customerId, f.operationId)).toEqual({ ok: false, code: 'ACQUISITION_REJECTED' });
    expect(await redis.get(key)).toBe(before);
    expect(await redis.get(checkoutPinKey(f.manifest.resources[0]!.markerId))).toBeNull();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'PREPARED', settlementReplayId: null });
  });

  it('pinned old generation rejects RESOURCE_ADVANCE after current cart intent advances', async () => {
    const f = await preparedAcquisition();
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    const resource = f.manifest.resources[0]!;
    const guardBefore = await redis.get(resourceGuardKey(resource.markerId));
    const pinBefore = await redis.get(checkoutPinKey(resource.markerId));
    await prisma.cartReservationSyncState.update({ where: { id: resource.markerId }, data: { generation: resource.generation + 1 } });
    expect(await metadata.initializeResource(resource.markerId, f.customerId, resource.generation + 1, randomUUID(), true))
      .toMatchObject({ code: 'FENCE_REJECTED' });
    expect(await redis.get(resourceGuardKey(resource.markerId))).toBe(guardBefore);
    expect(await redis.get(checkoutPinKey(resource.markerId))).toBe(pinBefore);
  });

  it('an uncertain request that never reached W4 retries with the same PREPARED identity', async () => {
    const f = await preparedAcquisition();
    const original = adapter.eval.bind(adapter);
    const execution = jest.spyOn(adapter, 'eval').mockImplementation(async (...args) => {
      if (args[0] === CHECKOUT_ACQUIRE_SCRIPT) throw new Error('Injected transport failure before execution');
      return original(...args);
    });
    expect(await acquisition.acquire(f.customerId, f.operationId)).toEqual({ ok: false, code: 'ACQUISITION_UNCERTAIN' });
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'PREPARED', acquisitionReplayId: f.manifest.acquisitionReplayId });
    expect(await redis.get(`reservation:fence:settlement-acquisition:${f.manifest.id}`)).toBeNull();
    execution.mockRestore();
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', acquisitionReplayId: f.manifest.acquisitionReplayId });
  });

  it('a failed PG acknowledgement leaves physical evidence recoverable and PREPARED intact', async () => {
    const f = await preparedAcquisition();
    const failure = jest.spyOn(manifests, 'markAcquired').mockImplementationOnce(() => { throw new Error('Injected acknowledgement failure'); });
    expect(await acquisition.acquire(f.customerId, f.operationId)).toEqual({ ok: false, code: 'ACQUISITION_UNCERTAIN' });
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'PREPARED' });
    expect(await redis.get(`reservation:fence:settlement-acquisition:${f.manifest.id}`)).not.toBeNull();
    failure.mockRestore();
    const execute = jest.spyOn(adapter, 'eval');
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    expect(execute.mock.calls.filter(call => call[0] === CHECKOUT_ACQUIRE_SCRIPT)).toHaveLength(0);
  });

  it('ACQUIRED with missing physical evidence fails closed without repeating W4 or replacing identity', async () => {
    const f = await preparedAcquisition();
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    await redis.del(`reservation:fence:settlement-acquisition:${f.manifest.id}`);
    const execute = jest.spyOn(adapter, 'eval');
    expect(await acquisition.acquire(f.customerId, f.operationId)).toEqual({ ok: false, code: 'ACQUISITION_REJECTED' });
    expect(execute.mock.calls.filter(call => call[0] === CHECKOUT_ACQUIRE_SCRIPT)).toHaveLength(0);
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', acquisitionReplayId: f.manifest.acquisitionReplayId });
  });

  it('proven order rollback settles W5 without invoking old revert or W6', async () => {
    const f = await scenario();
    jest.spyOn(handles.ordersService, 'createOrderInTransaction').mockRejectedValueOnce(new Error('Injected transaction failure'));
    const revert = jest.spyOn(handles.checkoutReservationRecovery, 'checkoutRevert');
    const finalize = jest.spyOn(handles.checkoutReservationRecovery, 'finalizeCheckoutConsumption');
    expect(await dispatcher.checkout({ customerId: f.customerId, cartId: f.cartId, retryKey: f.retryKey,
      dto: f.dto, now: f.now })).toEqual({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });
    const a = await prisma.checkoutAttempt.findFirstOrThrow({ where: { customerId: f.customerId } });
    expect(a).toMatchObject({ status: 'FAILED', orderId: null, failureCode: 'ORDER_TRANSACTION_ROLLED_BACK' });
    expect(await prisma.checkoutReservationSettlement.findUnique({ where: { attemptId: a.id } }))
      .toMatchObject({ state: 'SETTLED', effect: 'CHECKOUT_REVERT_DELETE_ONLY' });
    expect(revert).not.toHaveBeenCalled(); expect(finalize).not.toHaveBeenCalled();
    expect(await prisma.order.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await prisma.payment.count({ where: { order: { customerId: f.customerId } } })).toBe(0);
  });

  it('historical NULL-E operations and attempts remain unchanged and cannot acquire', async () => {
    const f = await scenario();
    const op = await prisma.checkoutOperation.create({ data: { customerId: f.customerId, cartId: f.cartId,
      operationKey: randomUUID(), retryKeyHash: randomUUID(), selectedPath: 'CART_SCOPED' } });
    const attempt = await prisma.checkoutAttempt.create({ data: { customerId: f.customerId, cartId: f.cartId,
      idempotencyKey: op.operationKey, selectedPath: 'CART_SCOPED' } });
    const execute = jest.spyOn(adapter, 'eval');
    expect(await acquisition.acquire(f.customerId, op.id)).toEqual({ ok: false, code: 'ACQUISITION_REJECTED' });
    expect(execute).not.toHaveBeenCalled();
    expect(await prisma.checkoutOperation.findUnique({ where: { id: op.id } })).toEqual(op);
    expect(await prisma.checkoutAttempt.findUnique({ where: { id: attempt.id } })).toEqual(attempt);
    expect(await prisma.checkoutReservationSettlement.count({ where: { attemptId: attempt.id } })).toBe(0);
  });

  it('concurrent acquisition shares one immutable manifest and replay identity', async () => {
    const f = await preparedAcquisition();
    const results = await Promise.all([acquisition.acquire(f.customerId, f.operationId), acquisition.acquire(f.customerId, f.operationId)]);
    expect(results.some(result => result.ok)).toBe(true);
    expect(await prisma.checkoutReservationSettlement.count({ where: { attemptId: f.attempt.id } })).toBe(1);
    expect(await manifests.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', acquisitionReplayId: f.manifest.acquisitionReplayId,
      settlementReplayId: null, resources: f.manifest.resources });
    const entry: unknown = JSON.parse((await redis.get(reservationKey(f.cartId, f.productId)))!);
    expect(entry).toMatchObject({ quantity: f.quantity, checkoutAttemptId: f.attempt.id,
      holdInstanceId: f.manifest.resources[0]!.holdInstanceId });
    expect(await acquisition.acquire(f.customerId, f.operationId)).toMatchObject({ ok: true });
    expect(JSON.parse((await redis.get(reservationKey(f.cartId, f.productId)))!)).toEqual(entry);
  });
});
