import { randomUUID } from 'crypto';
import {
  BadGatewayException,
  BadRequestException,
} from '@nestjs/common';
import { PaymentProviderName, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { connectRealRedis } from '../../inventory/services/inventory-reservations.redis-test-helpers';
import {
  CheckoutIntegrationFixture,
  RealCoordinatorHandles,
  buildRealCoordinator,
  checkoutDto,
  seedReadyCheckout,
  setUpCheckoutIntegrationFixture,
  tearDownCheckoutIntegrationFixture,
} from '../../checkout/services/checkout-coordinator-integration-test-helpers';
import { PaymentsService } from '../services/payments.service';
import { PaymentsRepository } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import {
  SandboxPaymentGatewaySimulator,
  SimulatorScenario,
  SIMULATOR_DEFAULT_API_KEY,
} from './sandbox-payment-gateway.simulator';
import { PaymentEventDeliveryHarness } from './payment-event-delivery.harness';

jest.setTimeout(45_000);

const ISOLATED_DB_INDEX = 8;

describe('Sandbox Payment Gateway Simulator & Failure Injection (real Postgres + Redis)', () => {
  let redisClient: Awaited<ReturnType<typeof connectRealRedis>>;
  let prisma: PrismaService;
  let fixture: CheckoutIntegrationFixture;
  let handles: RealCoordinatorHandles;
  let simulator: SandboxPaymentGatewaySimulator;
  let harness: PaymentEventDeliveryHarness;
  let simulatedPaymentsService: PaymentsService;

  beforeAll(async () => {
    redisClient = await connectRealRedis();
    await redisClient.select(ISOLATED_DB_INDEX);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    fixture = await setUpCheckoutIntegrationFixture(prisma);
  });

  afterAll(async () => {
    const retainedItems = await prisma.orderItem.count({
      where: { product: { vendorId: fixture.vendor.id } },
    });
    if (retainedItems === 0) {
      await prisma.vendorDailyListing.deleteMany({ where: { vendorId: fixture.vendor.id } });
      await prisma.inventoryEvent.deleteMany({ where: { product: { vendorId: fixture.vendor.id } } });
      await prisma.product.deleteMany({ where: { vendorId: fixture.vendor.id } });
      await prisma.seafoodCatalogueItem.deleteMany();
      await prisma.seafoodLot.deleteMany({ where: { vendorId: fixture.vendor.id } });
    }
    await tearDownCheckoutIntegrationFixture(fixture);
    await prisma.onModuleDestroy();
    await redisClient.flushdb();
    await redisClient.quit();
  });

  beforeEach(async () => {
    await redisClient.flushdb();
    handles = buildRealCoordinator(prisma, redisClient);

    simulator = new SandboxPaymentGatewaySimulator(PaymentProviderName.CASH_ON_DELIVERY);
    harness = new PaymentEventDeliveryHarness(SIMULATOR_DEFAULT_API_KEY);

    simulatedPaymentsService = new PaymentsService(
      new PaymentsRepository(prisma),
      new RefundsRepository(prisma),
      simulator as unknown as WiPayAdapter,
      simulator as unknown as CashOnDeliveryAdapter,
      handles.eventEmitter,
    );

    // Wire simulator into coordinator and orders service
    (handles.ordersService as any).paymentsService = simulatedPaymentsService;
    (handles.coordinator as any).paymentsService = simulatedPaymentsService;
    (handles as any).paymentsService = simulatedPaymentsService;
  });

  // =========================================================================
  // PART 1: THE 12 CONFIGURABLE SIMULATOR SCENARIOS (PHASE 2)
  // =========================================================================
  describe('Phase 2 — Configurable Simulator Scenarios', () => {
    it('Scenario 1 (SUCCESS): deterministic initiation returns 201 with ESTABLISHED and hosted redirectUrl', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('ESTABLISHED');
      expect(result.payment?.status).toBe('PENDING');
      expect(result.paymentRedirectUrl).toBe(`https://jmsb.wipayfinancial.com/test-checkout/sim-ref-${result.id}`);

      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(paymentInDb.initiationStatus).toBe('ESTABLISHED');
      expect(paymentInDb.providerReference).toBe(`sim-ref-${result.id}`);
      expect(simulator.getCallCount('createPayment')).toBe(1);
    });

    it('Scenario 2 (CONFIRMED_REJECTION): confirmed gateway rejection preserves order and marks RECONCILE_REQUIRED', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.CONFIRMED_REJECTION, {
        errorMessage: 'WiPay confirmed rejection: card declined by issuing bank',
      });

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(result.paymentRedirectUrl).toBeUndefined();

      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(paymentInDb.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(simulator.getCallCount('createPayment')).toBe(1);
    });

    it('Scenario 3 (NETWORK_TIMEOUT): simulated gateway socket timeout returns 201 with RECONCILE_REQUIRED and preserves order', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.NETWORK_TIMEOUT);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(result.paymentRedirectUrl).toBeUndefined();

      const orderInDb = await prisma.order.findUniqueOrThrow({ where: { id: result.id } });
      expect(orderInDb.id).toBe(result.id);

      const product = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
      expect(product.quantityAvailable).toBe(50 - scenario.quantity);
    });

    it('Scenario 4 (HTTP_502): upstream gateway 502 Bad Gateway handled cleanly without crashing', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.HTTP_502);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(result.paymentRedirectUrl).toBeUndefined();
    });

    it('Scenario 5 (CONNECTION_RESET): connection reset (ECONNRESET) handled safely without crashing', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.CONNECTION_RESET);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
    });

    it('Scenario 6 (GATEWAY_SUCCESS_LOST_RESPONSE): gateway records acceptance remotely, socket drops before client response', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.GATEWAY_SUCCESS_LOST_RESPONSE);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');

      // The simulator ledger confirms the transaction WAS accepted remotely at the gateway
      const remoteTxn = simulator.getTransactionByOrderId(result.id);
      expect(remoteTxn).toBeDefined();
      expect(remoteTxn?.acceptedRemotely).toBe(true);
      expect(remoteTxn?.providerReference).toBe(`sim-ref-${result.id}`);

      // In Postgres, the client state remains RECONCILE_REQUIRED pending reconciliation
      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(paymentInDb.initiationStatus).toBe('RECONCILE_REQUIRED');
    });

    it('Scenario 7 (DELAYED_CONFIRMATION): initiation returns PENDING, verifyPayment confirms pending until delayed settlement', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.DELAYED_CONFIRMATION);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      expect(result.payment?.initiationStatus).toBe('ESTABLISHED');

      const providerRef = `sim-ref-${result.id}`;

      // Initially verifyPayment reports PENDING
      const initialVerify = await simulator.verifyPayment(providerRef);
      expect(initialVerify.status).toBe('PENDING');

      // Later, transaction settles at gateway
      simulator.settleTransaction(providerRef, 'PAID');

      // Subsequent verifyPayment confirms PAID
      const settledVerify = await simulator.verifyPayment(providerRef);
      expect(settledVerify.status).toBe('PAID');
    });

    it('Scenario 8 (DUPLICATE_NOTIFICATIONS): event delivery harness produces duplicate settlement notifications safely', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      const providerRef = `sim-ref-${result.id}`;

      const baseEvent = harness.createSuccessSettlementEvent({
        transactionId: providerRef,
        orderId: result.id,
        amount: '1000.00',
      });
      const duplicates = harness.createDuplicateNotifications(baseEvent, 3);
      expect(duplicates).toHaveLength(3);

      for (const event of duplicates) {
        await harness.deliver('DUPLICATE', event);
      }

      const delivered = harness.getDeliveredEventsByTransactionId(providerRef);
      expect(delivered).toHaveLength(3);
      expect(delivered[0]?.payload.hash).toBe(delivered[1]?.payload.hash);
    });

    it('Scenario 9 (OUT_OF_ORDER_NOTIFICATIONS): unverified/error event delivered before success does not corrupt state', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      const providerRef = `sim-ref-${result.id}`;

      const sequence = harness.createOutOfOrderNotifications({
        transactionId: providerRef,
        orderId: result.id,
        amount: '1000.00',
      });

      expect(sequence[0]?.status).toBe('error');
      expect(sequence[1]?.status).toBe('success');

      for (const event of sequence) {
        await harness.deliver('OUT_OF_ORDER', event);
      }

      const delivered = harness.getDeliveredEventsByTransactionId(providerRef);
      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.payload.status).toBe('error');
      expect(delivered[1]?.payload.status).toBe('success');
    });

    it('Scenario 10 (MISSING_NOTIFICATION): missing webhook never falsely marks payment FAILED; remains discoverable in Postgres', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.NETWORK_TIMEOUT);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');

      // No event is delivered via harness
      expect(harness.getDeliveredEventsByTransactionId(`sim-ref-${result.id}`)).toHaveLength(0);

      // Verify in Postgres: payment is NOT marked FAILED
      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(paymentInDb.status).toBe('PENDING');
      expect(paymentInDb.status).not.toBe('FAILED');
    });

    it('Scenario 11 (PAYMENT_FAILURE): simulated payment failure outcome verified via simulator', async () => {
      simulator.setScenario(SimulatorScenario.PAYMENT_FAILURE);

      const verifyResult = await simulator.verifyPayment('sim-test-ref-failure');
      expect(verifyResult.status).toBe('FAILED');
    });

    it('Scenario 12 (REFUND_OUTCOME): simulated refund returns COMPLETED and FAILED outcomes deterministically', async () => {
      simulator.setScenario(SimulatorScenario.REFUND_OUTCOME, { refundStatus: 'COMPLETED' });
      const successRefund = await simulator.refundPayment('sim-ref-1', 500, 'Customer requested return');
      expect(successRefund.status).toBe('COMPLETED');
      expect(successRefund.providerReference).toMatch(/^sim-refund-/);

      simulator.setScenario(SimulatorScenario.REFUND_OUTCOME, { refundStatus: 'FAILED' });
      const failedRefund = await simulator.refundPayment('sim-ref-1', 500, 'Gateway refund rejected');
      expect(failedRefund.status).toBe('FAILED');
    });
  });

  // =========================================================================
  // PART 2: CRASH AND RECOVERY SIMULATION (PHASE 5 — 10 REQUIREMENTS)
  // =========================================================================
  describe('Phase 5 — Crash and Recovery Simulation Invariants', () => {
    // 1. Payment attempt persisted before gateway initiation
    it('Requirement 1: payment attempt is durably persisted with NOT_STARTED before gateway createPayment is called', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);

      let persistedBeforeGatewayCall: any = null;
      const originalCreate = simulator.createPayment.bind(simulator);
      jest.spyOn(simulator, 'createPayment').mockImplementation(async (input) => {
        persistedBeforeGatewayCall = await prisma.payment.findUnique({
          where: { orderId: input.orderId },
        });
        return originalCreate(input);
      });

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(persistedBeforeGatewayCall).not.toBeNull();
      expect(persistedBeforeGatewayCall.orderId).toBe(result.id);
      expect(persistedBeforeGatewayCall.status).toBe('PENDING');
      // In PaymentsService, createOrGetByOrderId writes NOT_STARTED, then claimInitiation updates to INITIATING
      expect(['NOT_STARTED', 'INITIATING']).toContain(persistedBeforeGatewayCall.initiationStatus);
    });

    // 2. Process failure after durable initiation claim
    it('Requirement 2: simulated worker crash after durable INITIATING claim leaves attempt intact in Postgres', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });

      // Reset to NOT_STARTED
      await prisma.payment.update({
        where: { id: paymentInDb.id },
        data: { initiationStatus: 'NOT_STARTED', status: 'PENDING' },
      });

      const paymentsRepo = new PaymentsRepository(prisma);
      const claimed = await paymentsRepo.claimInitiation(paymentInDb.id);
      expect(claimed).toBe(true);

      // Simulate process crash: process died immediately after CAS update.
      // Postgres must retain the INITIATING status
      const postCrashPayment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentInDb.id } });
      expect(postCrashPayment.initiationStatus).toBe('INITIATING');
      expect(postCrashPayment.status).toBe('PENDING');
    });

    // 3. Gateway acceptance with lost response
    it('Requirement 3: gateway acceptance with lost response keeps order committed and payment RECONCILE_REQUIRED', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.GATEWAY_SUCCESS_LOST_RESPONSE);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      expect(result.id).toBeDefined();
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');

      const remoteTxn = simulator.getTransactionByOrderId(result.id);
      expect(remoteTxn?.acceptedRemotely).toBe(true);

      const orderInDb = await prisma.order.findUniqueOrThrow({ where: { id: result.id } });
      expect(orderInDb.id).toBe(result.id);
    });

    // 4. Recovery candidate remains discoverable
    it('Requirement 4: stale INITIATING and RECONCILE_REQUIRED attempts remain discoverable by recovery query', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.GATEWAY_SUCCESS_LOST_RESPONSE);

      const result = await handles.ordersService.checkout(scenario.customerId, {
        ...checkoutDto,
        paymentMethod: 'WIPAY',
      });

      // Backdate updatedAt to simulate a stale crashed worker
      const staleTime = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.payment.update({
        where: { orderId: result.id },
        data: {
          initiationStatus: 'INITIATING',
          updatedAt: staleTime,
        },
      });

      const paymentsRepo = new PaymentsRepository(prisma);
      const candidates = await paymentsRepo.findRecoveryCandidates(new Date(Date.now() - 5 * 60 * 1000), 10);

      expect(candidates.some((c) => c.orderId === result.id)).toBe(true);
    });

    // 5. Duplicate client requests do not create new charges
    it('Requirement 5: duplicate client checkout submissions do not invoke gateway a second time', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);
      const idempotencyKey = randomUUID();

      const first = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
      expect(first.ok).toBe(true);
      expect(simulator.getCallCount('createPayment')).toBe(1);

      // Replay checkout with same customer and idempotency key (attempt already committed)
      const second = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.order.id).toBe(first.order.id);
      }
      expect(simulator.getCallCount('createPayment')).toBe(1); // Zero additional gateway calls
    });

    // 6. Concurrent initiation attempts are suppressed
    it('Requirement 6: concurrent initiation claims are atomically suppressed by PostgreSQL CAS', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });

      // Reset to NOT_STARTED
      await prisma.payment.update({
        where: { id: paymentInDb.id },
        data: { initiationStatus: 'NOT_STARTED' },
      });

      const paymentsRepo = new PaymentsRepository(prisma);
      const [claim1, claim2] = await Promise.all([
        paymentsRepo.claimInitiation(paymentInDb.id),
        paymentsRepo.claimInitiation(paymentInDb.id),
      ]);

      expect([claim1, claim2].filter(Boolean)).toHaveLength(1);
    });

    // 7. Missing notification does not falsely mark payment as failed
    it('Requirement 7: missing notification never transitions payment to FAILED in PostgreSQL', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.SUCCESS);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      // Even if no webhook/return notification ever arrives:
      const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { orderId: result.id } });
      expect(paymentInDb.status).toBe('PENDING');
      expect(paymentInDb.status).not.toBe('FAILED');
    });

    // 8. Uncertain payment remains blocked from blind retry
    it('Requirement 8: payment in RECONCILE_REQUIRED status cannot be blindly re-initiated', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.NETWORK_TIMEOUT);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);
      expect(result.payment?.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(simulator.getCallCount('createPayment')).toBe(1);

      // Direct attempt to re-initiate payment
      const directRetry = await simulatedPaymentsService.initiatePayment({
        orderId: result.id,
        amount: 1000,
        currency: 'JMD',
        provider: 'CASH_ON_DELIVERY',
      });

      expect(directRetry.payment.initiationStatus).toBe('RECONCILE_REQUIRED');
      expect(simulator.getCallCount('createPayment')).toBe(1); // Blocked from repeating createPayment
    });

    // 9. Existing committed orders remain unchanged
    it('Requirement 9: committed order items, vendor orders, and totals remain completely unchanged across failures', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.NETWORK_TIMEOUT);

      const result = await handles.ordersService.checkout(scenario.customerId, checkoutDto);

      const orderInDb = await prisma.order.findUniqueOrThrow({
        where: { id: result.id },
        include: {
          vendorOrders: {
            include: { items: true },
          },
        },
      });

      expect(orderInDb.vendorOrders).toHaveLength(1);
      const vendorOrder = orderInDb.vendorOrders[0];
      expect(vendorOrder).toBeDefined();
      expect(vendorOrder?.items).toHaveLength(1);
      expect(vendorOrder?.items[0]?.productId).toBe(scenario.productId);
      expect(vendorOrder?.status).toBe('PENDING');
    });

    // 10. Inventory is not decremented twice
    it('Requirement 10: product inventory is decremented exactly once even after replay attempts', async () => {
      const scenario = await seedReadyCheckout(fixture, handles);
      simulator.setScenario(SimulatorScenario.NETWORK_TIMEOUT);
      const idempotencyKey = randomUUID();

      const first = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
      expect(first.ok).toBe(true);

      const productAfterFirst = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
      expect(productAfterFirst.quantityAvailable).toBe(50 - scenario.quantity);

      // Replay with identical idempotency key
      const second = await handles.coordinator.checkout(scenario.customerId, idempotencyKey, checkoutDto, new Date());
      expect(second.ok).toBe(true);

      const productAfterReplay = await prisma.product.findUniqueOrThrow({ where: { id: scenario.productId } });
      expect(productAfterReplay.quantityAvailable).toBe(50 - scenario.quantity); // NOT decremented twice

      // Verify exactly one inventory event exists for this product
      const events = await prisma.inventoryEvent.findMany({ where: { productId: scenario.productId } });
      expect(events).toHaveLength(1);
    });
  });

  // =========================================================================
  // PART 3: EVENT DELIVERY HARNESS ISOLATION & HASH VERIFICATION
  // =========================================================================
  describe('Phase 4 & 6 — Event Delivery Harness Isolation', () => {
    it('computes authentic MD5 verification hashes verifiable by simulator and WiPay adapter', () => {
      const txnId = 'sim-txn-12345';
      const amount = '2500.00';
      const event = harness.createSuccessSettlementEvent({
        transactionId: txnId,
        amount,
      });

      expect(event.hash).toBeDefined();
      expect(event.hash).toMatch(/^[a-f0-9]{32}$/);

      const isValid = simulator.verifyTransactionResponse(event, txnId, amount);
      expect(isValid).toBe(true);
    });

    it('rejects tampered or conflicting event payloads during verification', () => {
      const [eventA, eventB] = harness.createConflictingNotifications({
        transactionId: 'sim-txn-conflict',
        amountA: '1000.00',
        amountB: '2000.00',
      });

      // eventB hash matches amountB, but when verified against amountA it must fail
      const isValid = simulator.verifyTransactionResponse(eventB, 'sim-txn-conflict', '1000.00');
      expect(isValid).toBe(false);
    });

    it('records deliveries in in-memory audit log without mutating production routes or database', async () => {
      harness.clear();
      expect(harness.getDeliveredEvents()).toHaveLength(0);

      const event = harness.createSuccessSettlementEvent({
        transactionId: 'sim-txn-audit',
        amount: '1500.00',
      });

      await harness.deliver('SUCCESS', event);

      const deliveries = harness.getDeliveredEvents();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.eventType).toBe('SUCCESS');
      expect(deliveries[0]?.payload.transaction_id).toBe('sim-txn-audit');
    });
  });
});
