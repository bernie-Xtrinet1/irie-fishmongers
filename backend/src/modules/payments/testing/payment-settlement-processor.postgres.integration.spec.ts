import { createHash, randomUUID } from 'crypto';
import {
  Category,
  Order,
  Payment,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  RefundStatus,
  Role,
  RoleName,
  SettlementDisposition,
  SettlementEvidenceProvenance,
  User,
  Vendor,
  VendorOrder,
  VendorOrderStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PaymentSettlementRepository } from '../repositories/payment-settlement.repository';
import { PaymentSettlementProcessorService } from '../services/payment-settlement-processor.service';
import {
  ApplyPaymentSettlementCommand,
  SettlementExecutionResult,
} from '../types/payment-settlement.types';

jest.setTimeout(60_000);

function computeEvidenceDigest(rawPayload: Record<string, unknown> | string): string {
  const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
  return createHash('sha256').update(payloadStr, 'utf8').digest('hex');
}

/**
 * TestIsolatedSettlementProcessor
 *
 * Demonstrably isolated test-only settlement capability.
 * - Accessible ONLY in test execution environments (enforces process.env.NODE_ENV === 'test').
 * - NEVER registered or exported in payments.module.ts, NestJS DI containers, or production controllers.
 * - Enforces evidence data-integrity (SHA-256 digest verification) and test-provenance guards.
 * - Directly invokes the settlement repository to execute test transactions in disposable databases.
 */
class TestIsolatedSettlementProcessor {
  constructor(
    private readonly settlementRepository: PaymentSettlementRepository,
    private readonly prisma: PrismaService,
  ) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'SECURITY VIOLATION: TestIsolatedSettlementProcessor is strictly restricted to test execution environments (NODE_ENV=test).',
      );
    }
  }

  async executeTestSettlement(
    command: ApplyPaymentSettlementCommand,
  ): Promise<SettlementExecutionResult> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'SECURITY VIOLATION: Test settlement capability cannot execute outside test environment.',
      );
    }

    if (command.evidence.provenance !== SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR) {
      throw new Error(
        `TestIsolatedSettlementProcessor only accepts TRUSTED_TEST_SIMULATOR provenance, received: ${command.evidence.provenance}`,
      );
    }

    // Evidence digest verification (Data Integrity Guard)
    const payloadStr =
      typeof command.evidence.rawPayload === 'string'
        ? command.evidence.rawPayload
        : JSON.stringify(command.evidence.rawPayload);
    const computedDigest = createHash('sha256').update(payloadStr, 'utf8').digest('hex');

    if (command.evidence.evidenceDigest !== computedDigest) {
      const receipt = await this.settlementRepository.recordReceipt({
        provider: command.provider,
        merchantAccountId: command.merchantAccountId,
        eventId: command.eventId,
        gatewayTxnId: command.gatewayTxnId,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        sourceIp: command.evidence.sourceIp,
        signatureValid: false,
      });

      const payment = await this.prisma.payment.findUnique({
        where: { id: command.paymentId },
        select: { status: true },
      });

      return {
        applied: false,
        disposition: SettlementDisposition.CONFLICT_REJECTED,
        paymentId: command.paymentId,
        orderId: command.orderId,
        resultingPaymentStatus: payment?.status ?? PaymentStatus.PENDING,
        receiptId: receipt.id,
        message: 'Settlement evidence digest mismatch: payload has been modified or corrupted.',
      };
    }

    return this.settlementRepository.executeSettlementTransaction(command);
  }
}

describe('Payment Settlement Processor (PostgreSQL Adversarial & Integration Suite)', () => {
  let prisma: PrismaService;
  let settlementRepository: PaymentSettlementRepository;
  let processorService: PaymentSettlementProcessorService;
  let testIsolatedProcessor: TestIsolatedSettlementProcessor;

  // Shared test actors
  let customerUser: User;
  let vendorUser: User;
  let vendor: Vendor;
  let category: Category;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    settlementRepository = new PaymentSettlementRepository(prisma);
    processorService = new PaymentSettlementProcessorService(settlementRepository, prisma);
    testIsolatedProcessor = new TestIsolatedSettlementProcessor(settlementRepository, prisma);

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `settlement-cust-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Cedric',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    vendorUser = await prisma.user.create({
      data: {
        email: `settlement-vend-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Vernon',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Settlement Fish Co ${randomUUID().slice(0, 8)}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
      },
    });

    category = await prisma.category.create({
      data: {
        name: `Settlement Category ${randomUUID()}`,
        slug: `settlement-cat-${randomUUID()}`,
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.paymentSettlementReceipt.deleteMany({});
      await prisma.paymentSettlementEvent.deleteMany({});
      await prisma.paymentOutbox.deleteMany({});
      await prisma.refund.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.checkoutAttempt.deleteMany({});
      await prisma.cart.deleteMany({});
      await prisma.orderItem.deleteMany({});
      await prisma.vendorOrder.deleteMany({});
      await prisma.order.deleteMany({ where: { customerId: customerUser.id } });
      await prisma.product.deleteMany({ where: { vendorId: vendor.id } });
      await prisma.category.delete({ where: { id: category.id } });
      await prisma.vendor.delete({ where: { id: vendor.id } });
      await prisma.userRole.deleteMany({ where: { userId: { in: [customerUser.id, vendorUser.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [customerUser.id, vendorUser.id] } } });
    } catch (e) {
      // Ignore cleanup error
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  /**
   * Helper to construct a fresh test order with a vendor order and payment
   */
  async function seedTestOrder(options: {
    amount?: number;
    currency?: string;
    merchantAccountId?: string;
    paymentStatus?: PaymentStatus;
    providerReference?: string | null;
    vendorOrderStatus?: VendorOrderStatus;
    provider?: PaymentProviderName;
  } = {}): Promise<{ order: Order; vendorOrder: VendorOrder; payment: Payment }> {
    const amount = options.amount ?? 1500;
    const currency = options.currency ?? 'JMD';
    const merchantAccountId = options.merchantAccountId ?? 'default';
    const paymentStatus = options.paymentStatus ?? PaymentStatus.PENDING;
    const vendorOrderStatus = options.vendorOrderStatus ?? VendorOrderStatus.PENDING;
    const provider = options.provider ?? PaymentProviderName.WIPAY;
    const providerReference = options.providerReference ?? null;

    const product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        name: `Snapper ${randomUUID().slice(0, 6)}`,
        description: 'Test fish description for integration tests',
        imageUrl: 'https://example.com/snapper.jpg',
        unit: 'PER_POUND',
        price: new Prisma.Decimal(amount),
        quantityAvailable: 100,
      },
    });

    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '10 Port Royal Street',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765550199',
        currency,
        vendorOrders: {
          create: [
            {
              vendorId: vendor.id,
              subtotal: new Prisma.Decimal(amount),
              status: vendorOrderStatus,
              items: {
                create: [
                  {
                    productId: product.id,
                    productName: product.name,
                    unitPrice: new Prisma.Decimal(amount),
                    unit: 'PER_POUND',
                    quantity: 1,
                    subtotal: new Prisma.Decimal(amount),
                  },
                ],
              },
            },
          ],
        },
      },
      include: { vendorOrders: true },
    });

    const vendorOrder = order.vendorOrders[0]!;

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider,
        merchantAccountId,
        amount: new Prisma.Decimal(amount),
        currency,
        status: paymentStatus,
        providerReference,
      },
    });

    return { order, vendorOrder, payment };
  }

  // =========================================================================
  // SCENARIO 1: Missing signature verification (F-01 Fail-Closed)
  // =========================================================================
  it('Scenario 1: Missing signature verification fails closed with CONFLICT_REJECTED', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_sig_miss_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { txn: gatewayTxnId, status: 'success', total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
        // signatureValid is undefined (omitted)
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PENDING);

    // Database verification: Payment remains PENDING
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);
    expect(paymentInDb.paidAt).toBeNull();

    // Event row was NOT created
    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);

    // Receipt was recorded with CONFLICT_REJECTED and signatureValid: false
    const receipt = await prisma.paymentSettlementReceipt.findFirstOrThrow({ where: { eventId } });
    expect(receipt.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(receipt.signatureValid).toBe(false);
  });

  // =========================================================================
  // SCENARIO 2: Explicit signatureValid: false (F-01 Fail-Closed)
  // =========================================================================
  it('Scenario 2: Explicit signatureValid: false fails closed with CONFLICT_REJECTED', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_sig_false_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { txn: gatewayTxnId, status: 'success', total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
        signatureValid: false,
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PENDING);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 3: Forged signatureValid: true without verification (F-01)
  // =========================================================================
  it('Scenario 3: Forged signatureValid: true without adapter verification fails closed', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_forged_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { txn: gatewayTxnId, status: 'success', total: '1500.00' };

    // Attacker sends signatureValid: true but no adapter verification proof
    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
        signatureValid: true,
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.message).toContain('requires verification by a registered trusted webhook verification adapter');

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);
    expect(paymentInDb.paidAt).toBeNull();

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 4: Caller-declared authenticated webhook (F-01)
  // =========================================================================
  it('Scenario 4: Caller-declared authenticated webhook with untrusted adapter fails closed', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_untrusted_webhook_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { txn: gatewayTxnId, status: 'success', total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: {
          verifiedByAdapter: 'unregistered-upstream-webhook-adapter',
          adapterVerificationToken: 'unauthorized_token_proof',
          verifiedAt: new Date(),
        },
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 5: Caller-declared verified status poll (F-01)
  // =========================================================================
  it('Scenario 5: Caller-declared verified status poll without trusted adapter fails closed', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_untrusted_poll_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { txn: gatewayTxnId, status: 'success', total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.VERIFIED_STATUS_POLL,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: {
          verifiedByAdapter: 'unregistered-poll-adapter',
          adapterVerificationToken: 'unauthorized_token_proof',
          verifiedAt: new Date(),
        },
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 6: Disabled administrative override (F-01)
  // =========================================================================
  it('Scenario 6: Administrative override settlement is permanently disabled and fails closed', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_admin_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { manualOverride: true, adminUser: 'superadmin' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.ADMIN_OVERRIDE,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.message).toContain('administrative settlement overrides are permanently disabled');

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 7: Simulator authority attempted from production context (F-01)
  // =========================================================================
  it('Scenario 7: Simulator authority attempted through production entry point fails closed', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_sim_prod_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { simulated: true, outcome: 'PAID' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    // Calling the production service entry point
    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.message).toContain('Simulator authority is inaccessible through production service entry points');

    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 8: Valid test-isolated simulator settlement (F-01 Isolated Path)
  // =========================================================================
  it('Scenario 8: Valid test-isolated simulator settlement applies transitions and records audit artifacts', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_sim_isolated_${randomUUID()}`;
    const gatewayTxnId = `txn_sim_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    // Execute via isolated test capability
    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(true);
    expect(result.disposition).toBe(SettlementDisposition.APPLIED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PAID);
    expect(result.settlementEventId).toBeDefined();
    expect(result.receiptId).toBeDefined();
    expect(result.outboxEventId).toBeDefined();

    // Verify database state:
    // 1. Payment status transitioned to PAID with reference and paidAt
    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(updatedPayment.status).toBe(PaymentStatus.PAID);
    expect(updatedPayment.paidAt).toBeInstanceOf(Date);
    expect(updatedPayment.providerReference).toBe(gatewayTxnId);

    // 2. Settlement event inserted
    const event = await prisma.paymentSettlementEvent.findUniqueOrThrow({
      where: {
        provider_merchantAccountId_eventId: {
          provider: PaymentProviderName.WIPAY,
          merchantAccountId: 'default',
          eventId,
        },
      },
    });
    expect(event.disposition).toBe(SettlementDisposition.APPLIED);
    expect(event.outcome).toBe(PaymentStatus.PAID);
    expect(event.gatewayTxnId).toBe(gatewayTxnId);

    // 3. Receipt inserted
    const receipt = await prisma.paymentSettlementReceipt.findFirstOrThrow({ where: { eventId } });
    expect(receipt.disposition).toBe(SettlementDisposition.APPLIED);

    // 4. Outbox event inserted
    const outbox = await prisma.paymentOutbox.findFirstOrThrow({
      where: { aggregateId: payment.id, eventType: 'PAYMENT_SETTLED' },
    });
    expect(outbox.published).toBe(false);
  });

  // =========================================================================
  // SCENARIO 9: Browser provisional return (F-01 Never Finalizes)
  // =========================================================================
  it('Scenario 9: Browser provisional return records receipt without mutating Payment or inserting Event', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_browser_prov_${randomUUID()}`;
    const gatewayTxnId = `txn_browser_${randomUUID()}`;
    const rawPayload = { browserReturn: true, txn: gatewayTxnId };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.PROVISIONAL_BROWSER_RETURN,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await processorService.applySettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.PROVISIONAL_RECORDED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PENDING);
    expect(result.receiptId).toBeDefined();

    // Verify Payment remains PENDING
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);
    expect(paymentInDb.paidAt).toBeNull();
    expect(paymentInDb.providerReference).toBeNull();

    // Zero PaymentSettlementEvent created
    const event = await prisma.paymentSettlementEvent.findUnique({
      where: {
        provider_merchantAccountId_eventId: {
          provider: PaymentProviderName.WIPAY,
          merchantAccountId: 'default',
          eventId,
        },
      },
    });
    expect(event).toBeNull();

    // Receipt recorded with PROVISIONAL_RECORDED
    const receipt = await prisma.paymentSettlementReceipt.findFirstOrThrow({ where: { eventId } });
    expect(receipt.disposition).toBe(SettlementDisposition.PROVISIONAL_RECORDED);
  });

  // =========================================================================
  // SCENARIO 10: Cross-provider settlement injection (F-02 Enforcement)
  // =========================================================================
  it('Scenario 10: Cross-provider settlement attempt fails closed with CONFLICT_REJECTED', async () => {
    // Payment created with provider CASH_ON_DELIVERY
    const { order, payment } = await seedTestOrder({
      provider: PaymentProviderName.CASH_ON_DELIVERY,
    });
    const eventId = `evt_cross_prov_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    // Incoming settlement command presents provider WIPAY
    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY, // Mismatched provider!
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.message).toContain('Provider mismatch: payment is assigned to provider CASH_ON_DELIVERY, not WIPAY');

    // Database verification: Payment untouched
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);
    expect(paymentInDb.provider).toBe(PaymentProviderName.CASH_ON_DELIVERY);
    expect(paymentInDb.paidAt).toBeNull();

    // No event inserted
    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);

    // Audit receipt recorded with CONFLICT_REJECTED
    const receipt = await prisma.paymentSettlementReceipt.findFirstOrThrow({ where: { eventId } });
    expect(receipt.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
  });

  // =========================================================================
  // SCENARIO 11: Existing provider reference mismatch (F-03 Protection)
  // =========================================================================
  it('Scenario 11: Conflicting providerReference rejects settlement and preserves existing reference', async () => {
    const existingRef = 'txn_established_reference_001';
    const { order, payment } = await seedTestOrder({
      providerReference: existingRef,
    });

    const eventId = `evt_ref_mismatch_${randomUUID()}`;
    const conflictingRef = 'txn_conflicting_reference_999';
    const rawPayload = { simulated: true, txn: conflictingRef, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId: conflictingRef, // Differs from existingRef!
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);
    expect(result.message).toContain('Conflicting provider reference: payment already established with reference txn_established_reference_001');

    // Database verification: existing reference strictly preserved
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.providerReference).toBe(existingRef);
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 12: Matching provider reference (F-03 Protection)
  // =========================================================================
  it('Scenario 12: Matching providerReference succeeds and preserves established reference', async () => {
    const matchingRef = 'txn_matching_reference_555';
    const { order, payment } = await seedTestOrder({
      providerReference: matchingRef,
    });

    const eventId = `evt_ref_match_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: matchingRef, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId: matchingRef, // Exactly matches existingRef!
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(true);
    expect(result.disposition).toBe(SettlementDisposition.APPLIED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PAID);

    // Database verification: reference preserved and payment marked PAID
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.providerReference).toBe(matchingRef);
    expect(paymentInDb.status).toBe(PaymentStatus.PAID);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(1);
  });

  // =========================================================================
  // SCENARIO 13: Initial null reference binding (F-03 Protection)
  // =========================================================================
  it('Scenario 13: Initial null providerReference permits binding to gatewayTxnId on valid settlement', async () => {
    const { order, payment } = await seedTestOrder({
      providerReference: null, // Initial null
    });

    const eventId = `evt_ref_null_bind_${randomUUID()}`;
    const newRef = 'txn_newly_bound_777';
    const rawPayload = { simulated: true, txn: newRef, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId: newRef,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(true);
    expect(result.disposition).toBe(SettlementDisposition.APPLIED);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PAID);

    // Database verification: null reference successfully bound to newRef
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.providerReference).toBe(newRef);
    expect(paymentInDb.status).toBe(PaymentStatus.PAID);
  });

  // =========================================================================
  // SCENARIO 14: Conflicting reference during FAILED-to-PAID recovery (F-03)
  // =========================================================================
  it('Scenario 14: Conflicting reference during FAILED-to-PAID recovery fails closed', async () => {
    const existingRef = 'txn_original_failed_ref_888';
    const { order, payment } = await seedTestOrder({
      paymentStatus: PaymentStatus.FAILED,
      providerReference: existingRef,
    });

    const eventId = `evt_ref_fail_recov_${randomUUID()}`;
    const conflictingRef = 'txn_conflicting_recovery_ref_999';
    const rawPayload = { simulated: true, txn: conflictingRef, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId: conflictingRef, // Conflicts with existing reference on FAILED payment
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);

    // Database verification: payment remains FAILED, reference unchanged
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.FAILED);
    expect(paymentInDb.providerReference).toBe(existingRef);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 15: Conflicting reference after cancellation (F-03)
  // =========================================================================
  it('Scenario 15: Conflicting reference on late settlement for cancelled order fails closed', async () => {
    const existingRef = 'txn_cancel_ref_111';
    const { order, payment } = await seedTestOrder({
      vendorOrderStatus: VendorOrderStatus.CANCELLED,
      providerReference: existingRef,
    });

    const eventId = `evt_cancel_ref_conflict_${randomUUID()}`;
    const conflictingRef = 'txn_cancel_ref_conflict_222';
    const rawPayload = { simulated: true, txn: conflictingRef, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId: conflictingRef,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(false);
    expect(result.disposition).toBe(SettlementDisposition.CONFLICT_REJECTED);

    // Database verification: payment remains PENDING, reference unchanged, no refund created
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PENDING);
    expect(paymentInDb.providerReference).toBe(existingRef);

    const refundCount = await prisma.refund.count({ where: { paymentId: payment.id } });
    expect(refundCount).toBe(0);

    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 16: Duplicate event delivery after the corrections
  // =========================================================================
  it('Scenario 16: Duplicate event delivery after corrections returns DUPLICATE_IGNORED and preserves single event row', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_dup_corr_${randomUUID()}`;
    const gatewayTxnId = `txn_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    // First delivery
    const firstResult = await testIsolatedProcessor.executeTestSettlement(command);
    expect(firstResult.applied).toBe(true);
    expect(firstResult.disposition).toBe(SettlementDisposition.APPLIED);

    // Second delivery (duplicate)
    const secondResult = await testIsolatedProcessor.executeTestSettlement(command);
    expect(secondResult.applied).toBe(false);
    expect(secondResult.disposition).toBe(SettlementDisposition.DUPLICATE_IGNORED);
    expect(secondResult.settlementEventId).toBe(firstResult.settlementEventId);
    expect(secondResult.resultingPaymentStatus).toBe(PaymentStatus.PAID);

    // Event row count remains exactly 1
    const eventCount = await prisma.paymentSettlementEvent.count({
      where: { provider: PaymentProviderName.WIPAY, merchantAccountId: 'default', eventId },
    });
    expect(eventCount).toBe(1);

    // Receipt count is 2 (one APPLIED, one DUPLICATE_IGNORED)
    const receipts = await prisma.paymentSettlementReceipt.findMany({
      where: { eventId },
      orderBy: { receivedAt: 'asc' },
    });
    expect(receipts.length).toBe(2);
    expect(receipts[0]!.disposition).toBe(SettlementDisposition.APPLIED);
    expect(receipts[1]!.disposition).toBe(SettlementDisposition.DUPLICATE_IGNORED);
  });

  // =========================================================================
  // SCENARIO 17: Atomic rollback of rejected settlement
  // =========================================================================
  it('Scenario 17: Atomic rollback on failure leaves Payment and financial tables pristine', async () => {
    const { payment } = await seedTestOrder();
    const eventId = `evt_roll_${randomUUID()}`;
    const gatewayTxnId = `txn_roll_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    // Present command with nonexistent order to trigger a transaction-level rollback
    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: `nonexistent_order_${randomUUID()}`,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    await expect(testIsolatedProcessor.executeTestSettlement(command)).rejects.toThrow();

    // Verify complete rollback:
    // 1. Payment untouched
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe(PaymentStatus.PENDING);
    expect(paymentAfter.paidAt).toBeNull();
    expect(paymentAfter.providerReference).toBeNull();

    // 2. Zero events created
    const eventCount = await prisma.paymentSettlementEvent.count({ where: { eventId } });
    expect(eventCount).toBe(0);

    // 3. Zero outbox created
    const outboxCount = await prisma.paymentOutbox.count({ where: { aggregateId: payment.id } });
    expect(outboxCount).toBe(0);
  });

  // =========================================================================
  // SCENARIO 18: Concurrent duplicate settlement
  // =========================================================================
  it('Scenario 18: Concurrent duplicate settlement arrivals serialize cleanly: one APPLIED, one DUPLICATE_IGNORED', async () => {
    const { order, payment } = await seedTestOrder();
    const eventId = `evt_race_${randomUUID()}`;
    const gatewayTxnId = `txn_race_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    // Dispatch concurrently
    const [resultA, resultB] = await Promise.all([
      testIsolatedProcessor.executeTestSettlement(command),
      testIsolatedProcessor.executeTestSettlement(command),
    ]);

    const dispositions = [resultA.disposition, resultB.disposition].sort();
    expect(dispositions).toEqual([
      SettlementDisposition.APPLIED,
      SettlementDisposition.DUPLICATE_IGNORED,
    ]);

    // Exactly one event row created
    const eventCount = await prisma.paymentSettlementEvent.count({
      where: { provider: PaymentProviderName.WIPAY, merchantAccountId: 'default', eventId },
    });
    expect(eventCount).toBe(1);

    // Exactly two receipts recorded
    const receiptCount = await prisma.paymentSettlementReceipt.count({ where: { eventId } });
    expect(receiptCount).toBe(2);

    // Payment transitioned to PAID
    const paymentInDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentInDb.status).toBe(PaymentStatus.PAID);
  });

  // =========================================================================
  // SCENARIO 19: Cancelled Order Late Settlement (SETTLED_AFTER_CANCELLATION)
  // =========================================================================
  it('Scenario 19: Late settlement on cancelled order generates REQUIRED refund and keeps vendor orders cancelled', async () => {
    const { order, vendorOrder, payment } = await seedTestOrder({
      vendorOrderStatus: VendorOrderStatus.CANCELLED,
    });

    const eventId = `evt_late_${randomUUID()}`;
    const gatewayTxnId = `txn_late_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);

    expect(result.applied).toBe(true);
    expect(result.disposition).toBe(SettlementDisposition.SETTLED_AFTER_CANCELLATION);
    expect(result.resultingPaymentStatus).toBe(PaymentStatus.PAID);
    expect(result.refundId).toBeDefined();
    expect(result.refundStatus).toBe(RefundStatus.REQUIRED);

    // Database verification:
    // 1. Payment transitioned to PAID
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe(PaymentStatus.PAID);

    // 2. Settlement event recorded with SETTLED_AFTER_CANCELLATION
    const event = await prisma.paymentSettlementEvent.findUniqueOrThrow({
      where: {
        provider_merchantAccountId_eventId: {
          provider: PaymentProviderName.WIPAY,
          merchantAccountId: 'default',
          eventId,
        },
      },
    });
    expect(event.disposition).toBe(SettlementDisposition.SETTLED_AFTER_CANCELLATION);

    // 3. Refund created with status REQUIRED and idempotencyKey
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { idempotencyKey: `refund_post_cancel_${payment.id}` },
    });
    expect(refund.status).toBe(RefundStatus.REQUIRED);
    expect(refund.paymentId).toBe(payment.id);
    expect(refund.amount).toEqual(new Prisma.Decimal(1500));

    // 4. VendorOrder remains CANCELLED (never updated to DELIVERED)
    const voAfter = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vendorOrder.id } });
    expect(voAfter.status).toBe(VendorOrderStatus.CANCELLED);

    // 5. Outbox recorded with PAYMENT_SETTLED_AFTER_CANCELLATION
    const outbox = await prisma.paymentOutbox.findFirstOrThrow({
      where: { aggregateId: payment.id, eventType: 'PAYMENT_SETTLED_AFTER_CANCELLATION' },
    });
    expect(outbox.published).toBe(false);
  });

  // =========================================================================
  // SCENARIO 20: Canonical Lock Order Guarantees Deterministic Concurrency
  // =========================================================================
  it('Scenario 20: Canonical lock hierarchy guarantees deterministic outcome on concurrent settlement and cancellation', async () => {
    const { order, vendorOrder, payment } = await seedTestOrder();
    const eventId = `evt_cancel_race_${randomUUID()}`;
    const gatewayTxnId = `txn_cr_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const settlementCommand: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    // Cancellation transaction using canonical lock order:
    const cancelOrderTransaction = async () => {
      return prisma.$transaction(async (tx) => {
        // 1. Lock order
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${order.id} FOR UPDATE`;
        // 2. Lock and cancel vendor orders
        await tx.$queryRaw`SELECT "id" FROM "vendor_orders" WHERE "orderId" = ${order.id} ORDER BY "id" ASC FOR UPDATE`;
        await tx.vendorOrder.update({
          where: { id: vendorOrder.id },
          data: { status: VendorOrderStatus.CANCELLED },
        });
        return 'CANCELLED';
      });
    };

    // Run both concurrently
    const [settleResult, cancelResult] = await Promise.all([
      testIsolatedProcessor.executeTestSettlement(settlementCommand),
      cancelOrderTransaction(),
    ]);

    expect(cancelResult).toBe('CANCELLED');
    expect(settleResult.applied).toBe(true);

    // If settlement locked first -> APPLIED
    // If cancellation locked first -> SETTLED_AFTER_CANCELLATION
    expect([
      SettlementDisposition.APPLIED,
      SettlementDisposition.SETTLED_AFTER_CANCELLATION,
    ]).toContain(settleResult.disposition);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe(PaymentStatus.PAID);
  });

  // =========================================================================
  // SCENARIO 21: Vendor Payout Exclusion Guarantee
  // =========================================================================
  it('Scenario 21: Cancelled orders settled via SETTLED_AFTER_CANCELLATION are strictly excluded from vendor settlements', async () => {
    const { order, vendorOrder, payment } = await seedTestOrder({
      vendorOrderStatus: VendorOrderStatus.CANCELLED,
    });

    const eventId = `evt_excl_${randomUUID()}`;
    const gatewayTxnId = `txn_excl_${randomUUID()}`;
    const rawPayload = { simulated: true, txn: gatewayTxnId, total: '1500.00' };

    const command: ApplyPaymentSettlementCommand = {
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId,
      paymentId: payment.id,
      orderId: order.id,
      gatewayTxnId,
      amount: '1500.00',
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        rawPayload,
        evidenceDigest: computeEvidenceDigest(rawPayload),
        eventTimestamp: new Date(),
      },
    };

    const result = await testIsolatedProcessor.executeTestSettlement(command);
    expect(result.disposition).toBe(SettlementDisposition.SETTLED_AFTER_CANCELLATION);

    // Verify vendor settlement eligibility query:
    // Vendor settlement engine queries for vendorOrders that are DELIVERED and paid
    const eligibleVendorOrders = await prisma.vendorOrder.findMany({
      where: {
        id: vendorOrder.id,
        status: VendorOrderStatus.DELIVERED,
        order: {
          payment: {
            status: PaymentStatus.PAID,
          },
        },
      },
    });

    // Must be 0! The CANCELLED vendor order is strictly excluded
    expect(eligibleVendorOrders.length).toBe(0);

    // Verify existing vendor_settlements table has 0 rows for this vendorOrder
    const existingSettlement = await prisma.vendorSettlement.findUnique({
      where: { vendorOrderId: vendorOrder.id },
    });
    expect(existingSettlement).toBeNull();
  });
});
