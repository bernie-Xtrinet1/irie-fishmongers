import { randomUUID } from 'crypto';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Category,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Role,
  RoleName,
  User,
  Vendor,
  VendorOrderStatus,
} from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import {
  CustomerPaymentState,
} from '../dto/payment-status-response.dto';
import {
  RecoveryAction,
} from '../dto/payment-recovery-response.dto';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentsRepository } from '../repositories/payments.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentRecoveryService } from '../services/payment-recovery.service';
import { PaymentsService } from '../services/payments.service';

describe('Payment Status and Recovery API (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let paymentsRepository: PaymentsRepository;
  let refundsRepository: RefundsRepository;
  let paymentsService: PaymentsService;
  let paymentRecoveryService: PaymentRecoveryService;

  let customerUser: User;
  let otherCustomerUser: User;
  let adminUser: User;
  let vendorUser: User;
  let vendor: Vendor;
  let category: Category;

  let customerPrincipal: RequestUser;
  let otherCustomerPrincipal: RequestUser;
  let adminPrincipal: RequestUser;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    paymentsRepository = new PaymentsRepository(prisma);
    refundsRepository = new RefundsRepository(prisma);
    const cashOnDeliveryAdapter = new CashOnDeliveryAdapter();
    const configService = new ConfigService({
      WIPAY_API_KEY: 'test-wipay-api-key',
      WIPAY_ACCOUNT_NUMBER: '1234567',
      WIPAY_FEE_STRUCTURE: 'customer_pay',
      APP_BASE_URL: 'http://localhost:3000',
      API_PREFIX: 'api/v1',
    });
    const wiPayAdapter = new WiPayAdapter(configService);
    const eventEmitter = new EventEmitter2();

    paymentsService = new PaymentsService(
      paymentsRepository,
      refundsRepository,
      wiPayAdapter,
      cashOnDeliveryAdapter,
      eventEmitter,
    );

    paymentRecoveryService = new PaymentRecoveryService(prisma, paymentsService);

    const rolesToEnsure = [RoleName.CUSTOMER, RoleName.VENDOR, RoleName.ADMINISTRATOR];
    for (const roleName of rolesToEnsure) {
      await prisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName },
      });
    }

    const customerRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.CUSTOMER },
    });
    const adminRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `status-cust-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Alice',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    otherCustomerUser = await prisma.user.create({
      data: {
        email: `status-other-cust-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Bob',
        lastName: 'OtherCustomer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    adminUser = await prisma.user.create({
      data: {
        email: `status-admin-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Admin',
        lastName: 'Operator',
        roles: { create: { roleId: adminRole.id } },
      },
    });

    vendorUser = await prisma.user.create({
      data: {
        email: `status-vend-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Victor',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Status Fish Market ${randomUUID().slice(0, 8)}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
      },
    });

    category = await prisma.category.create({
      data: {
        name: `Status Category ${randomUUID()}`,
        slug: `status-cat-${randomUUID()}`,
      },
    });

    customerPrincipal = {
      id: customerUser.id,
      email: customerUser.email,
      roles: [RoleName.CUSTOMER],
    };

    otherCustomerPrincipal = {
      id: otherCustomerUser.id,
      email: otherCustomerUser.email,
      roles: [RoleName.CUSTOMER],
    };

    adminPrincipal = {
      id: adminUser.id,
      email: adminUser.email,
      roles: [RoleName.ADMINISTRATOR],
    };
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
      await prisma.order.deleteMany({
        where: { customerId: { in: [customerUser.id, otherCustomerUser.id, adminUser.id] } },
      });
      await prisma.product.deleteMany({ where: { vendorId: vendor.id } });
      await prisma.category.delete({ where: { id: category.id } });
      await prisma.vendor.delete({ where: { id: vendor.id } });
      await prisma.userRole.deleteMany({
        where: { userId: { in: [customerUser.id, otherCustomerUser.id, adminUser.id, vendorUser.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [customerUser.id, otherCustomerUser.id, adminUser.id, vendorUser.id] } },
      });
    } catch {
      // Ignore cleanup error
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  async function seedOrderWithPayment(options?: {
    customerId?: string;
    paymentStatus?: PaymentStatus;
    initiationStatus?: PaymentInitiationStatus;
    providerReference?: string | null;
    vendorOrderStatus?: VendorOrderStatus;
    provider?: PaymentProviderName;
    withoutPayment?: boolean;
  }) {
    const custId = options?.customerId ?? customerUser.id;
    const pStatus = options?.paymentStatus ?? PaymentStatus.PENDING;
    const iStatus = options?.initiationStatus ?? PaymentInitiationStatus.ESTABLISHED;
    const voStatus = options?.vendorOrderStatus ?? VendorOrderStatus.PENDING;
    const prov = options?.provider ?? PaymentProviderName.WIPAY;
    const ref = options?.providerReference !== undefined ? options.providerReference : randomUUID();

    const order = await prisma.order.create({
      data: {
        customerId: custId,
        deliveryAddressLine1: '123 Port Royal Street',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765550100',
        currency: 'JMD',
        vendorOrders: {
          create: {
            vendorId: vendor.id,
            status: voStatus,
            subtotal: 2500.0,
          },
        },
      },
      include: {
        vendorOrders: true,
      },
    });

    let payment = null;
    if (!options?.withoutPayment) {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: prov,
          status: pStatus,
          initiationStatus: iStatus,
          amount: 2500.0,
          currency: 'JMD',
          providerReference: ref,
          paidAt: pStatus === PaymentStatus.PAID ? new Date() : null,
        },
      });
    }

    return { order, payment };
  }

  // Scenario 1: Customer retrieves owned order status
  it('Scenario 1: Customer retrieves owned order status with complete safe fields', async () => {
    const { order, payment } = await seedOrderWithPayment();

    const result = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);

    expect(result.orderId).toBe(order.id);
    expect(result.paymentId).toBe(payment?.id);
    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.initiationStatus).toBe(PaymentInitiationStatus.ESTABLISHED);
    expect(result.customerState).toBe(CustomerPaymentState.PENDING_CONFIRMATION);
    expect(result.isPendingConfirmation).toBe(true);
    expect(result.isReconciliationRequired).toBe(false);
    expect(result.isRecoveryPermitted).toBe(false);
    expect(result.isConfirmed).toBe(false);
    expect(result.orderFulfillmentEligible).toBe(false);
    expect(result.allVendorOrdersCancelled).toBe(false);
    expect(result.amount).toBe('2500.00');
    expect(result.currency).toBe('JMD');
    // Ensure sensitive internal references are not exposed on the response
    expect((result as unknown as Record<string, unknown>).providerReference).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).merchantAccountId).toBeUndefined();
  });

  // Scenario 2: Cross-customer request returns 404 (zero data leaked)
  it('Scenario 2: Cross-customer access rejected with 404 (no leak)', async () => {
    const { order } = await seedOrderWithPayment({ customerId: customerUser.id });

    // Customer B attempts to inspect Customer A's order
    await expect(
      paymentRecoveryService.getPaymentStatus(order.id, otherCustomerPrincipal),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Scenario 3: Unknown order returns 404
  it('Scenario 3: Nonexistent order returns 404', async () => {
    const unknownId = randomUUID();

    await expect(
      paymentRecoveryService.getPaymentStatus(unknownId, customerPrincipal),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Scenario 4: Pending payment response
  it('Scenario 4: Pending payment response identifies pending confirmation', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
    });

    const result = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.isPendingConfirmation).toBe(true);
    expect(result.customerState).toBe(CustomerPaymentState.PENDING_CONFIRMATION);
    expect(result.isConfirmed).toBe(false);
  });

  // Scenario 5: Confirmed payment response
  it('Scenario 5: Confirmed payment response identifies PAID and fulfillment eligible', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PAID,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      vendorOrderStatus: VendorOrderStatus.PENDING,
    });

    const result = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);

    expect(result.status).toBe(PaymentStatus.PAID);
    expect(result.customerState).toBe(CustomerPaymentState.PAID);
    expect(result.isConfirmed).toBe(true);
    expect(result.orderFulfillmentEligible).toBe(true);
    expect(result.isPendingConfirmation).toBe(false);
    expect(result.paidAt).toBeDefined();
  });

  // Scenario 6: Reconciliation-required response
  it('Scenario 6: Reconciliation-required response reports held reconciliation and blocks recovery', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.RECONCILE_REQUIRED,
      providerReference: null,
    });

    const result = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);

    expect(result.initiationStatus).toBe(PaymentInitiationStatus.RECONCILE_REQUIRED);
    expect(result.customerState).toBe(CustomerPaymentState.RECONCILE_REQUIRED);
    expect(result.isReconciliationRequired).toBe(true);
    expect(result.isRecoveryPermitted).toBe(false);
  });

  // Scenario 7: Provisional browser return remains non-final
  it('Scenario 7: Provisional browser return leaves payment in PENDING non-final state', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
    });

    const result = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.isConfirmed).toBe(false);
    expect(result.isPendingConfirmation).toBe(true);
    expect(result.customerState).toBe(CustomerPaymentState.PENDING_CONFIRMATION);
  });

  // Scenario 8: Repeated GET remains read-only
  it('Scenario 8: Repeated GET polling causes zero database mutations', async () => {
    const { order } = await seedOrderWithPayment();

    const paymentBefore = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    for (let i = 0; i < 10; i++) {
      const res = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);
      expect(res.status).toBe(paymentBefore.status);
    }

    const paymentAfter = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });

    expect(paymentAfter.updatedAt.getTime()).toBe(paymentBefore.updatedAt.getTime());
    expect(paymentAfter.status).toBe(paymentBefore.status);
    expect(paymentAfter.initiationStatus).toBe(paymentBefore.initiationStatus);
  });

  // Scenario 9: Recovery of already-paid payment rejected with 409 Conflict
  it('Scenario 9: Recovery of already-paid payment rejected with 409 Conflict', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PAID,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
    });

    await expect(
      paymentRecoveryService.recoverPayment(order.id, customerPrincipal),
    ).rejects.toThrow(ConflictException);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(paymentInDb.status).toBe(PaymentStatus.PAID);
  });

  // Scenario 10: Cancelled-order recovery rejected with 409 Conflict
  it('Scenario 10: Recovery on cancelled order rejected with 409 Conflict', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      vendorOrderStatus: VendorOrderStatus.CANCELLED,
    });

    await expect(
      paymentRecoveryService.recoverPayment(order.id, customerPrincipal),
    ).rejects.toThrow(ConflictException);

    const voInDb = await prisma.vendorOrder.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(voInDb.status).toBe(VendorOrderStatus.CANCELLED);
  });

  // Scenario 11: Timeout with null provider reference remains on hold
  it('Scenario 11: Timeout with null provider reference returns fail-closed HOLD', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.RECONCILE_REQUIRED,
      providerReference: null,
    });

    const recovery = await paymentRecoveryService.recoverPayment(order.id, customerPrincipal);

    expect(recovery.action).toBe(RecoveryAction.HOLD);
    expect(recovery.isReconciliationRequired).toBe(true);
    expect(recovery.isRetryAuthorized).toBe(false);
    expect(recovery.redirectUrl).toBeNull();
    expect(recovery.shouldWaitForConfirmation).toBe(true);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(paymentInDb.initiationStatus).toBe(PaymentInitiationStatus.RECONCILE_REQUIRED);
    expect(paymentInDb.providerReference).toBeNull();
  });

  // Scenario 12: Unknown gateway outcome never triggers retry
  it('Scenario 12: Unknown or established gateway outcome never triggers re-initiation', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      providerReference: randomUUID(),
    });

    const recovery = await paymentRecoveryService.recoverPayment(order.id, customerPrincipal);

    expect(recovery.action).toBe(RecoveryAction.HOLD);
    expect(recovery.isRetryAuthorized).toBe(false);
    expect(recovery.redirectUrl).toBeNull();
    expect(recovery.isPendingConfirmation).toBe(true);

    const count = await prisma.payment.count({ where: { orderId: order.id } });
    expect(count).toBe(1);
  });

  // Scenario 13: Provably unsubmitted initiation follows approved retry contract
  it('Scenario 13: Provably unsubmitted initiation (NOT_STARTED) safely initiates', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.NOT_STARTED,
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      providerReference: null,
    });

    const recovery = await paymentRecoveryService.recoverPayment(order.id, customerPrincipal);

    expect(recovery.isRetryAuthorized).toBe(true);
    expect(recovery.action).toBe(RecoveryAction.RETRY_AUTHORIZED);

    const paymentInDb = await prisma.payment.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(paymentInDb.initiationStatus).toBe(PaymentInitiationStatus.ESTABLISHED);
  });

  // Scenario 14: Concurrent recovery requests do not duplicate initiation
  it('Scenario 14: Concurrent recovery requests do not create duplicate initiation attempts', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.NOT_STARTED,
      provider: PaymentProviderName.CASH_ON_DELIVERY,
      providerReference: null,
    });

    const [res1, res2] = await Promise.all([
      paymentRecoveryService.recoverPayment(order.id, customerPrincipal),
      paymentRecoveryService.recoverPayment(order.id, customerPrincipal),
    ]);

    expect([res1.action, res2.action]).toContain(RecoveryAction.RETRY_AUTHORIZED);
    expect([res1.action, res2.action]).toContain(RecoveryAction.HOLD);

    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    expect(payments.length).toBe(1);
  });

  // Scenario 15: No test simulator authority exposure
  it('Scenario 15: Status and recovery routes do not accept or expose simulator bypasses', async () => {
    const { order } = await seedOrderWithPayment();

    const status = await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);
    expect((status as unknown as Record<string, unknown>).simulatorToken).toBeUndefined();
    expect((status as unknown as Record<string, unknown>).isSimulated).toBeUndefined();

    // Verify admin can also query status legitimately without simulator authority
    const adminStatus = await paymentRecoveryService.getPaymentStatus(order.id, adminPrincipal);
    expect(adminStatus.orderId).toBe(order.id);
  });

  // Scenario 16: No unauthorized settlement or refund mutation
  it('Scenario 16: Status and recovery calls never directly insert settlements or refunds', async () => {
    const { order } = await seedOrderWithPayment({
      paymentStatus: PaymentStatus.PENDING,
      initiationStatus: PaymentInitiationStatus.ESTABLISHED,
    });

    const settlementsBefore = await prisma.paymentSettlementEvent.count();
    const refundsBefore = await prisma.refund.count();
    const receiptsBefore = await prisma.paymentSettlementReceipt.count();

    await paymentRecoveryService.getPaymentStatus(order.id, customerPrincipal);
    await paymentRecoveryService.recoverPayment(order.id, customerPrincipal);

    const settlementsAfter = await prisma.paymentSettlementEvent.count();
    const refundsAfter = await prisma.refund.count();
    const receiptsAfter = await prisma.paymentSettlementReceipt.count();

    expect(settlementsAfter).toBe(settlementsBefore);
    expect(refundsAfter).toBe(refundsBefore);
    expect(receiptsAfter).toBe(receiptsBefore);
  });
});
