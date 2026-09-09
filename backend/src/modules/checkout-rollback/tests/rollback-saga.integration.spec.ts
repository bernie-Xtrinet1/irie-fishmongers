import { isDeepStrictEqual } from 'util';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutOperationService } from '../../checkout-operation/services/checkout-operation.service';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutAttemptStaleFencingService } from '../../checkout-attempt/services/checkout-attempt-stale-fencing.service';
import { PaymentsRepository } from '../../payments/repositories/payments.repository';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { PaymentsService } from '../../payments/services/payments.service';
import { WiPayAdapter } from '../../payments/providers/wipay.adapter';
import { CheckoutRecoveryWorkerService } from '../../checkout-recovery/services/checkout-recovery-worker.service';
import { CheckoutRecoveryLockService } from '../../checkout-recovery/services/checkout-recovery-lock.service';
import { CheckoutRecoveryTelemetryService } from '../../checkout-recovery/services/checkout-recovery-telemetry.service';
import { PaymentReconciliationService } from '../../payments/services/payment-reconciliation.service';
import { PaymentReconciliationBatchService } from '../../payments/services/payment-reconciliation-batch.service';
import { cleanupKeys, trackKeysFor, connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import { buildRealCoordinator, checkoutDto, seedReadyCheckout, setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture, CheckoutIntegrationFixture, RealCoordinatorHandles,
  ReadyCheckoutScenario } from '../../checkout/services/checkout-coordinator-integration-test-helpers';
import { assertDisposableEnvironment, collectRollbackEvidence, runFreshRecovery, withCleanup } from './rollback-evidence-test-helpers';

// BLOCKER assertions intentionally prove the current gap, never skip/todo or
// invert a desired safety assertion silently. See the numbered G.4a runbook.
jest.setTimeout(30000);
describe('G.4a saga failure evidence (real PostgreSQL/Redis)', () => {
  const prisma = new PrismaService();
  const keys = new Set<string>();
  let redis: Redis;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;
  let scenario: ReadyCheckoutScenario;
  let operations: CheckoutOperationService;
  let operationRepo: CheckoutOperationRepository;
  let key: string;
  const attempts = new CheckoutAttemptRepository(prisma);
  const undiscovered = { acquired: true, cleanupQueries: 1, staleQueries: 1, cleanupCandidates: 0,
    staleCandidates: 0, discoveryErrors: 0, cleanupCalls: 0, processingErrors: 0, skipped: 0 };
  const fault = () => new Error('G4A simulated lost response/crash');
  beforeAll(async () => {
    assertDisposableEnvironment();
    await prisma.$connect();
    redis = await connectRealRedis();
  });
  beforeEach(async () => {
    fixture = await setUpCheckoutIntegrationFixture(prisma);
    handles = buildRealCoordinator(prisma, redis);
    scenario = await seedReadyCheckout(fixture, handles);
    trackKeysFor(keys, scenario.cartId, scenario.productId);
    operationRepo = new CheckoutOperationRepository(prisma);
    operations = new CheckoutOperationService(operationRepo, handles.cartRepository,
      new PriceLockRepository(prisma), handles.priceLockService);
    const issued = await operations.issue({ ...input() });
    if (!issued.ok) throw new Error('Fixture issuance failed');
    key = issued.operation.operationKey;
    expect((await operations.assignPath(scenario.customerId, issued.operation.id, 'CART_SCOPED')).ok).toBe(true);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (!fixture) return;
    await withCleanup(async () => {
      await prisma.checkoutOperation.deleteMany({ where: { customerId: { in: fixture.userIds } } });
      await tearDownCheckoutIntegrationFixture(fixture);
    }, [async () => { if (redis) await cleanupKeys(redis, keys); keys.clear(); }]);
  });
  afterAll(async () => { await withCleanup(() => Promise.resolve(undefined),
    [async () => { if (redis) await redis.quit(); }, () => prisma.$disconnect()]); });
  function input() { return { customerId: scenario.customerId, cartId: scenario.cartId, retryKey: 'g4a-retry' }; }
  const checkout = () => handles.coordinator.checkout(scenario.customerId, key, checkoutDto, new Date());
  const evidence = async () => {
    const result = await collectRollbackEvidence(prisma, redis, {
      customerIds: [scenario.customerId], holds: [{ cartId: scenario.cartId, productId: scenario.productId }],
    });
    const serialized = JSON.stringify(result);
    // Boolean assertions keep even a sanitizer regression from printing secrets.
    expect([scenario.customerId, scenario.cartId, scenario.productId, key, 'g4a-retry']
      .some(value => serialized.includes(value))).toBe(false);
    return result;
  };
  async function noOrder(state: string | null, reservation = 'ACTIVE') {
    const e = await evidence();
    expect(e.paths).toEqual({ NULL: 0, LEGACY: 0, CART_SCOPED: 1 });
    expect(e.orders).toHaveLength(0); expect(e.payments).toHaveLength(0);
    expect(e.attempts.map(a => a.status)).toEqual(state ? [state] : []);
    expect(e.holds[0]?.status).toBe(reservation);
    return e;
  }
  async function stale() {
    await prisma.checkoutAttempt.update({ where: { idempotencyKey: key }, data: { lastHeartbeatAt: new Date(Date.now() - 600000) } });
  }
  async function runPayments() {
    const p = new PrismaService();
    const r = new Redis(process.env.REDIS_URL!);
    return withCleanup(async () => {
      const h = buildRealCoordinator(p, r), repo = new PaymentsRepository(p);
      const adapter = new WiPayAdapter(new ConfigService({ WIPAY_API_KEY: 'test-only' }));
      const create = jest.spyOn(adapter, 'createPayment');
      const verify = jest.spyOn(adapter, 'verifyPayment');
      const service = new PaymentsService(repo, new RefundsRepository(p), adapter, h.cashOnDeliveryAdapter, h.eventEmitter);
      const initiate = jest.spyOn(service, 'initiatePayment');
      const batch = new PaymentReconciliationBatchService(repo, new PaymentReconciliationService(repo, service));
      const outcome = await batch.runBatch({ now: new Date(), candidateStaleBefore: new Date(Date.now() - 1000), claimStaleBefore: new Date(Date.now() - 1000) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('Invalid recovery batch input');
      expect({ ...outcome.result, errors: outcome.result.errors.length, durationMs: 0 }).toEqual({
        candidatesFound: 0, attempted: 0, pending: 0, paid: 0, failed: 0,
        skipped: 0, providerReferenceMismatch: 0, staleClaim: 0, errors: 0, durationMs: 0 });
      expect(create.mock.calls.length).toBe(0); expect(verify.mock.calls.length).toBe(0);
      expect(initiate.mock.calls.length).toBe(0);
    }, [() => r.quit(), () => p.$disconnect()]);
  }

  it('M01 issuance rollback and M02 committed issuance lost-response retry preserve one mapping', async () => {
    const resolve = operationRepo.resolve.bind(operationRepo);
    jest.spyOn(operationRepo, 'resolve').mockImplementationOnce(async (...args) => { await resolve(...args); throw fault(); });
    await expect(operations.issue({ ...input(), retryKey: 'new-issuance' })).rejects.toThrow('G4A');
    expect((await evidence()).operations).toHaveLength(1);
    const committed = await operations.issue({ ...input(), retryKey: 'new-issuance' });
    // Response is deliberately discarded after the real transaction commits.
    const retry = await operations.issue({ ...input(), retryKey: 'new-issuance' });
    expect(isDeepStrictEqual(retry, committed)).toBe(true);
    const e = await evidence(); expect(e.operations).toHaveLength(2);
    expect(e.attempts).toHaveLength(0); expect(e.orders).toHaveLength(0); expect(e.payments).toHaveLength(0);
  });
  it('M05 preparation infrastructure failure retains ownership without attempt', async () => {
    const op = await prisma.checkoutOperation.findUniqueOrThrow({ where: { operationKey: key } });
    jest.spyOn(handles.priceLockService, 'validateCartPriceLocks').mockRejectedValueOnce(fault());
    await expect(operations.prepare(scenario.customerId, op.id, new Date())).rejects.toThrow('G4A');
    await noOrder(null);
  });
  it.each(['expiry', 'change'])('M06 bound price-lock %s requires reconfirmation, never reroutes', async kind => {
    const op = await prisma.checkoutOperation.findUniqueOrThrow({ where: { operationKey: key } });
    expect((await operations.prepare(scenario.customerId, op.id, new Date())).ok).toBe(true);
    const before = (await prisma.checkoutOperation.findUniqueOrThrow({ where: { operationKey: key } })).priceLockFingerprint;
    if (kind === 'change') await prisma.cartItem.updateMany({ where: { cartId: scenario.cartId }, data: { mutationVersion: { increment: 1 } } });
    expect(await operations.prepare(scenario.customerId, op.id,
      new Date(Date.now() + (kind === 'expiry' ? 86400000 : 0)))).toEqual({ ok: false, code: 'RECONFIRM_REQUIRED' });
    expect((await prisma.checkoutOperation.findUniqueOrThrow({ where: { operationKey: key } })).priceLockFingerprint === before).toBe(true);
    await noOrder(null);
  });
  it('M07 coordinator preparation failure occurs before attempt creation', async () => {
    jest.spyOn(handles.ordersService, 'prepareCheckout').mockRejectedValueOnce(fault());
    await expect(checkout()).rejects.toThrow('G4A'); await noOrder(null);
  });
  it('M08 uncertain successful Redis mark leaves PROCESSING; M16/M19/M21 fresh recovery fences and reverts', async () => {
    const mark = handles.checkoutReservationState.checkoutMark.bind(handles.checkoutReservationState);
    jest.spyOn(handles.checkoutReservationState, 'checkoutMark').mockImplementationOnce(async (...args) => { await mark(...args); throw fault(); });
    await expect(checkout()).rejects.toThrow('G4A'); await noOrder('PROCESSING', 'CHECKOUT_PENDING');
    expect(await checkout()).toEqual({ ok: false, code: 'CHECKOUT_ALREADY_IN_PROGRESS' });
    await stale(); expect((await runFreshRecovery()).acquired).toBe(true);
    const e = await noOrder('FAILED'); expect(e.failed).toEqual({ STALE_RECOVERY_FENCED: 1 });
  });
  it('M09/M10 transaction rolls back stock/order/commit and successful revert restores ACTIVE', async () => {
    jest.spyOn(handles.checkoutAttemptService, 'markCommittedInTransaction').mockRejectedValueOnce(fault());
    expect(await checkout()).toMatchObject({ ok: false, code: 'ORDER_TRANSACTION_FAILED' });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } })).quantityAvailable).toBe(50);
    await noOrder('FAILED');
    expect(await checkout()).toMatchObject({ ok: false, code: 'CHECKOUT_ALREADY_FAILED' });
  });
  it('M11/M33 BLOCKER-2 non-fenced failed revert stays pending and is absent from fresh-worker discovery', async () => {
    jest.spyOn(handles.checkoutAttemptService, 'markCommittedInTransaction').mockRejectedValueOnce(fault());
    jest.spyOn(handles.checkoutReservationRecovery, 'checkoutRevert').mockRejectedValueOnce(fault());
    expect(await checkout()).toMatchObject({ code: 'ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE' });
    const before = await noOrder('FAILED', 'CHECKOUT_PENDING');
    expect(before.failed).toEqual({ ORDER_TRANSACTION_FAILED_REVERT_INCOMPLETE: 1 });
    await stale(); expect(await runFreshRecovery()).toEqual(undiscovered);
    const after = await noOrder('FAILED', 'CHECKOUT_PENDING');
    expect(after.holds).toEqual(before.holds);
  });
  it('M12/M35 BLOCKER-4 COMMITTED finalize failure is not rediscovered after restart', async () => {
    jest.spyOn(handles.checkoutReservationRecovery, 'finalizeCheckoutConsumption').mockRejectedValueOnce(fault());
    expect((await checkout()).ok).toBe(true);
    const before = await evidence(); expect(before.committed).toEqual([expect.objectContaining({ orderPresent: true, payment: 'ESTABLISHED' })]);
    expect(before.holds[0]!.status).toBe('CHECKOUT_PENDING');
    await stale(); // Exclusion must not be explained by heartbeat freshness.
    expect(await runFreshRecovery()).toEqual(undiscovered);
    const fresh = buildRealCoordinator(prisma, redis);
    expect((await fresh.coordinator.checkout(scenario.customerId, key, checkoutDto, new Date())).ok).toBe(true);
    expect((await evidence()).holds).toEqual(before.holds);
    expect((await evidence()).orders).toHaveLength(1);
  });
  it('M13/M36 BLOCKER-3 committed order before payment: restart/replay and existing workers do not initiate', async () => {
    jest.spyOn(handles.eventEmitter, 'emitAsync').mockRejectedValueOnce(fault());
    const initiate = jest.spyOn(handles.paymentsService, 'initiatePayment');
    await expect(checkout()).rejects.toThrow('G4A'); expect(initiate).not.toHaveBeenCalled();
    const before = await evidence();
    expect(before.committed).toEqual([expect.objectContaining({ orderPresent: true, payment: 'MISSING' })]);
    expect(before.holds[0]!.status).toBe('ABSENT');
    const p = new PrismaService(), r = new Redis(process.env.REDIS_URL!);
    await withCleanup(async () => {
      const fresh = buildRealCoordinator(p, r);
      const create = jest.spyOn(fresh.paymentsService, 'initiatePayment');
      expect((await fresh.coordinator.checkout(scenario.customerId, key, checkoutDto, new Date())).ok).toBe(true);
      expect(create).not.toHaveBeenCalled();
    }, [() => r.quit(), () => p.$disconnect()]);
    await stale();
    expect(await runFreshRecovery()).toEqual(undiscovered); await runPayments();
    expect((await evidence()).payments).toHaveLength(0); expect((await evidence()).orders).toHaveLength(1);
  });
  it.each(['NOT_STARTED', 'INITIATING', 'RECONCILE_REQUIRED'] as const)('M14 BLOCKER-3 %s without reference is not automatically initiated', async status => {
    jest.spyOn(handles.eventEmitter, 'emitAsync').mockRejectedValueOnce(fault());
    await expect(checkout()).rejects.toThrow('G4A');
    const order = await prisma.order.findFirstOrThrow({ where: { customerId: scenario.customerId } });
    await prisma.payment.create({ data: { orderId: order.id, provider: 'WIPAY', amount: 1000, currency: 'JMD', initiationStatus: status,
      updatedAt: new Date(Date.now() - 600000) } });
    await runPayments();
    expect((await evidence()).payments).toEqual([expect.objectContaining({ initiationStatus: status, providerReferencePresent: false })]);
  });
  it('M19/M20/M21 fence survives crash and cleanup failure; restart is idempotent but ACTIVE still remains', async () => {
    const mark = handles.checkoutReservationState.checkoutMark.bind(handles.checkoutReservationState);
    jest.spyOn(handles.checkoutReservationState, 'checkoutMark').mockImplementationOnce(async (...args) => { await mark(...args); throw fault(); });
    await expect(checkout()).rejects.toThrow('G4A'); await stale();
    const a = (await attempts.findByIdempotencyKey(key))!;
    expect(await new CheckoutAttemptStaleFencingService(attempts).fence({ attemptId: a.id, customerId: scenario.customerId,
      selectedPath: 'CART_SCOPED', observedHeartbeatAt: a.lastHeartbeatAt,
      staleBefore: new Date(Date.now() - 180000), now: new Date() })).toEqual({ ok: true, outcome: 'FENCED' });
    // Crash boundary: no cleanup has run. A fresh worker must discover the DB row.
    await noOrder('FAILED', 'CHECKOUT_PENDING');
    const { CheckoutReservationRecoveryService } = await import('../../inventory/services/checkout-reservation-recovery.service');
    jest.spyOn(CheckoutReservationRecoveryService.prototype, 'checkoutRevert').mockRejectedValueOnce(fault());
    await runFreshRecovery(); await noOrder('FAILED', 'CHECKOUT_PENDING');
    await runFreshRecovery(); const cleaned = await noOrder('FAILED', 'ACTIVE');
    await runFreshRecovery(); expect((await evidence()).holds).toEqual(cleaned.holds);
    expect(cleaned.holds[0]!.total).toBe('2');
  });
  it('M14 ambiguous WiPay initiation is not recreated; unsupported lookup cannot manufacture payment truth', async () => {
    jest.spyOn(handles.eventEmitter, 'emitAsync').mockRejectedValueOnce(fault());
    await expect(checkout()).rejects.toThrow('G4A');
    const { id: orderId } = await prisma.order.findFirstOrThrow({ where: { customerId: scenario.customerId } });
    const adapter = new WiPayAdapter(new ConfigService({ WIPAY_API_KEY: 'test-only' }));
    const create = jest.spyOn(adapter, 'createPayment').mockRejectedValueOnce(fault());
    const repo = new PaymentsRepository(prisma);
    const service = new PaymentsService(repo, new RefundsRepository(prisma), adapter, handles.cashOnDeliveryAdapter, handles.eventEmitter);
    const input = { orderId, provider: 'WIPAY' as const, amount: 1000, currency: 'JMD' };
    await expect(service.initiatePayment(input)).rejects.toThrow('G4A');
    await service.initiatePayment(input);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await evidence()).payments[0]).toMatchObject({ initiationStatus: 'RECONCILE_REQUIRED', status: 'PENDING', providerReferencePresent: false });
    await expect(adapter.verifyPayment('fixture-reference')).rejects.toThrow('unsupported');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('M15 valid duplicate return is idempotent; invalid/unsigned/unknown return never overwrites stored truth', async () => {
    jest.spyOn(handles.eventEmitter, 'emitAsync').mockRejectedValueOnce(fault());
    await expect(checkout()).rejects.toThrow('G4A');
    const { id: orderId } = await prisma.order.findFirstOrThrow({ where: { customerId: scenario.customerId } });
    const ref = randomUUID(), secret = 'g4a-test-only-secret';
    await prisma.payment.create({ data: { orderId, provider: 'WIPAY', amount: 1000, currency: 'JMD', initiationStatus: 'ESTABLISHED', providerReference: ref } });
    const serialized = JSON.stringify(await evidence());
    expect([orderId, ref, secret].some(value => serialized.includes(value))).toBe(false);
    const service = new PaymentsService(new PaymentsRepository(prisma), new RefundsRepository(prisma),
      new WiPayAdapter(new ConfigService({ WIPAY_API_KEY: secret })), handles.cashOnDeliveryAdapter, handles.eventEmitter);
    const emit = jest.spyOn(handles.eventEmitter, 'emitAsync'); emit.mockClear();
    const payload = { status: 'success', transaction_id: ref, hash: createHash('md5').update(ref + '1000.00' + secret).digest('hex'),
      total: '0.01', order_id: randomUUID(), currency: 'USD', email: 'untrusted@example.invalid' };
    expect(await service.handleWiPayReturn(payload)).toEqual({ status: 'VERIFIED' });
    expect(await service.handleWiPayReturn(payload)).toEqual({ status: 'VERIFIED' });
    expect(emit).toHaveBeenCalledTimes(1);
    await expect(service.handleWiPayReturn({ ...payload, hash: 'bad' })).rejects.toThrow();
    await expect(service.handleWiPayReturn({ ...payload, transaction_id: randomUUID() })).rejects.toThrow();
    expect(await service.handleWiPayReturn({ transaction_id: ref, status: 'failed' })).toEqual({ status: 'UNVERIFIED' });
    const stored = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect({ status: stored.status, referenceMatches: stored.providerReference === ref, currency: stored.currency })
      .toEqual({ status: 'PAID', referenceMatches: true, currency: 'JMD' });
    expect(stored.amount.toFixed(2)).toBe('1000.00'); expect(stored.orderId === orderId).toBe(true);
    expect((await evidence()).orders).toHaveLength(1);
  });
  it('M34 more than one real discovery page advances without skipping tied heartbeats', async () => {
    const heartbeat = new Date(Date.now() - 600000);
    const rows = Array.from({ length: 105 }, () => ({ id: randomUUID(), customerId: scenario.customerId, cartId: scenario.cartId,
      idempotencyKey: randomUUID(), selectedPath: 'CART_SCOPED' as const, status: 'FAILED' as const,
      failureCode: 'STALE_RECOVERY_FENCED', lastHeartbeatAt: heartbeat }));
    await prisma.checkoutAttempt.createMany({ data: rows });
    const cleanup = jest.spyOn(handles.checkoutReservationRecovery, 'checkoutRevert');
    const worker = new CheckoutRecoveryWorkerService(handles.checkoutAttemptService, attempts, new CheckoutAttemptStaleFencingService(attempts),
      handles.checkoutReservationRecovery, new CheckoutRecoveryTelemetryService());
    const lock = new CheckoutRecoveryLockService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    expect(await lock.runExclusive(lease => worker.runCycle(lease))).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(100);
    expect(await lock.runExclusive(lease => worker.runCycle(lease))).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(105);
    expect(isDeepStrictEqual(new Set(cleanup.mock.calls.map(call => call[1])), new Set(rows.map(row => row.idempotencyKey)))).toBe(true);
    const e = await evidence(); expect(e.failed).toEqual({ STALE_RECOVERY_FENCED: 105 });
    expect(e.orders).toHaveLength(0); expect(e.payments).toHaveLength(0);
    expect(e.holds[0]!.total).toBe('2');
  });
  it('LEGACY lost-response limitation: existing order is not replayed by the legacy checkout entry point', async () => {
    // Exercise the legacy execution boundary without mixing accounting engines.
    await handles.inventoryReservations.releaseReservation(scenario.cartId, scenario.productId);
    const issued = await operations.issue({ ...input(), retryKey: 'legacy-operation' });
    if (!issued.ok) throw new Error('Legacy fixture issuance failed');
    await operations.assignPath(scenario.customerId, issued.operation.id, 'LEGACY');
    const committed = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
    await expect(handles.ordersService.checkout(scenario.customerId, checkoutDto)).rejects.toThrow();
    const e = await evidence();
    expect(e.orders).toHaveLength(1);
    expect(await prisma.order.count({ where: { id: committed.id, customerId: scenario.customerId } })).toBe(1); expect(e.attempts).toHaveLength(0);
    expect(e.ownership.filter(o => o.path === 'LEGACY')[0]?.path).toBe('LEGACY');
    // Refusal is not a successful durable replay and does not prove exactly-once
    // behavior if a caller changes the cart between retries.
  });
});
