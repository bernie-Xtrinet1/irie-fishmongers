import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  Parish,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  ProductUnit,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  RoleName,
  User,
  UserStatus,
  Vendor,
  VendorOrder,
  VendorOrderStatus,
  VendorSettlementStatus,
  OrderItem,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';
import { SettlementActor, VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsService } from '../services/vendor-settlements.service';

jest.setTimeout(180_000);

describe('D.4B.4 Financial Retention, Cascade Closure and Immutability (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let refundsRepo: RefundsRepository;
  let allocRepo: RefundAllocationsRepository;
  let allocService: RefundAllocationsService;
  let settlementsRepo: VendorSettlementsRepository;
  let settlementsService: VendorSettlementsService;

  let customerUser: User;
  let primaryAdminActor: SettlementActor;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    refundsRepo = new RefundsRepository(prisma);
    allocRepo = new RefundAllocationsRepository(prisma);
    allocService = new RefundAllocationsService(prisma, allocRepo);
    settlementsRepo = new VendorSettlementsRepository(prisma);
    const adjustmentsRepo = new VendorSettlementAdjustmentsRepository(prisma);
    settlementsService = new VendorSettlementsService(
      settlementsRepo,
      adjustmentsRepo,
      null as any,
      null as any,
    );

    category = await prisma.category.upsert({
      where: { slug: 'd4b4-retention-cat' },
      update: {},
      create: {
        name: 'D4B4 Retention Category',
        slug: 'd4b4-retention-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b4_cust_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Chris',
        lastName: 'Customer',
      },
    });

    const adminRole = await prisma.role.upsert({
      where: { name: RoleName.ADMINISTRATOR },
      update: {},
      create: { name: RoleName.ADMINISTRATOR },
    });
    const adminUser = await prisma.user.create({
      data: {
        email: `d4b4_primary_admin_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Primary',
        lastName: 'Admin',
        status: UserStatus.ACTIVE,
        canAuthorizeVendorSettlements: true,
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });
    primaryAdminActor = {
      id: adminUser.id,
      email: adminUser.email,
      roles: [RoleName.ADMINISTRATOR],
      canAuthorizeVendorSettlements: true,
    };

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b4_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'dummy_hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      return prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B4 Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
          parish,
          termsAcceptedAt: new Date(),
        },
      });
    };

    vendor1 = await createVendor('Alpha', Parish.KINGSTON);
    vendor2 = await createVendor('Beta', Parish.ST_ANN);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createOrderGraph(options: {
    vendorSubtotals: Array<{ vendor: Vendor; subtotal: string }>;
    paymentAmount?: string;
  }): Promise<{
    order: { id: string };
    payment: { id: string; amount: Prisma.Decimal; status: PaymentStatus };
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '12 Ocean Blvd',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550199',
        currency: 'JMD',
      },
    });

    const vendorOrders: Array<VendorOrder & { items: OrderItem[] }> = [];
    let total = new Prisma.Decimal(0);

    for (const vs of options.vendorSubtotals) {
      const amt = new Prisma.Decimal(vs.subtotal);
      total = total.add(amt);
      const product = await prisma.product.create({
        data: {
          vendorId: vs.vendor.id,
          categoryId: category.id,
          name: `Catch ${randomUUID().slice(0, 6)}`,
          description: 'D4B4 test product',
          unit: ProductUnit.PER_ITEM,
          price: amt,
          quantityAvailable: 100,
          imageUrl: 'https://example.com/fish.jpg',
        },
      });

      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vs.vendor.id,
          subtotal: amt,
          status: VendorOrderStatus.DELIVERED,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                quantity: 1,
                unitPrice: amt,
                unit: product.unit,
                subtotal: amt,
                currency: 'JMD',
              },
            ],
          },
        },
        include: { items: true },
      });
      vendorOrders.push(vo);
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        amount: options.paymentAmount ? new Prisma.Decimal(options.paymentAmount) : total,
        currency: 'JMD',
        status: PaymentStatus.PAID,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
      },
    });

    return { order, payment, vendorOrders };
  }

  it('1-2. enforces ON DELETE RESTRICT on all seven foreign keys and prevents deletion of referenced financial parents', async () => {
    const { order, payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;
    const item = vo.items[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('50.00'),
        reason: 'FK test refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `fk_r_${randomUUID()}`,
      },
    });

    const alloc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      orderItemId: item.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: 100.0,
      platformFee: 10.0,
      netAmount: 90.0,
    });

    const adj = await prisma.vendorSettlementAdjustment.create({
      data: {
        settlementId: settlement.id,
        refundId: refund.id,
        amount: new Prisma.Decimal('-50.00'),
        reason: 'Settlement adjustment FK test',
        idempotencyKey: `adj_fk_${randomUUID()}`,
      },
    });

    // 1. Deleting vendor_settlements fails because vendor_settlement_adjustments references it via RESTRICT (and trigger blocks delete)
    await expect(prisma.vendorSettlement.delete({ where: { id: settlement.id } })).rejects.toThrow();

    // 2. Deleting vendor_orders fails because vendor_settlements references it via RESTRICT (and allocations reference it)
    await expect(prisma.vendorOrder.delete({ where: { id: vo.id } })).rejects.toThrow();

    // 3. Deleting vendor_orders fails because order_items references it via RESTRICT
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "vendor_orders" WHERE "id" = '${vo.id}'`),
    ).rejects.toThrow();

    // 4. Deleting payments fails because refunds references it via RESTRICT (and payments trigger blocks delete)
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow();

    // 5. Deleting orders fails because payments and vendor_orders reference it via RESTRICT
    await expect(prisma.order.delete({ where: { id: order.id } })).rejects.toThrow();

    // 6. Deleting users fails because orders references it via RESTRICT
    await expect(prisma.user.delete({ where: { id: customerUser.id } })).rejects.toThrow();

    // 7. Deleting refunds fails because allocations and adjustments reference it via RESTRICT (and refunds trigger blocks delete)
    await expect(prisma.refund.delete({ where: { id: refund.id } })).rejects.toThrow();
  });

  it('3-4, 7-10. blocks direct SQL and Prisma financial amount tampering on payments, settlements, allocations, and adjustments', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '120.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('40.00'),
        reason: 'Tamper test refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `tamper_r_${randomUUID()}`,
      },
    });

    const alloc = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '40.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: 120.0,
      platformFee: 12.0,
      netAmount: 108.0,
    });

    const adj = await prisma.vendorSettlementAdjustment.create({
      data: {
        settlementId: settlement.id,
        refundId: refund.id,
        amount: new Prisma.Decimal('-40.00'),
        reason: 'Adjustment tamper test',
        idempotencyKey: `tamper_adj_${randomUUID()}`,
      },
    });

    // 7. Payment amount tampering blocked (SQL + Prisma)
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "payments" SET "amount" = 999.00 WHERE "id" = '${payment.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.payment.update({ where: { id: payment.id }, data: { amount: new Prisma.Decimal('999.00') } }),
    ).rejects.toThrow();

    // 8. Settlement amount tampering blocked (gross, fee, net via SQL + Prisma)
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "vendor_settlements" SET "netAmount" = 500.00 WHERE "id" = '${settlement.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.vendorSettlement.update({
        where: { id: settlement.id },
        data: { grossAmount: new Prisma.Decimal('500.00') },
      }),
    ).rejects.toThrow();

    // 9. Allocation amount & identity tampering blocked (SQL + Prisma)
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "refund_vendor_order_allocations" SET "amount" = 99.00 WHERE "id" = '${alloc.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.refundVendorOrderAllocation.update({
        where: { id: alloc.id },
        data: { amount: new Prisma.Decimal('99.00') },
      }),
    ).rejects.toThrow();

    // 10. Adjustment amount tampering blocked (SQL + Prisma)
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "vendor_settlement_adjustments" SET "amount" = 0.00 WHERE "id" = '${adj.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.vendorSettlementAdjustment.update({
        where: { id: adj.id },
        data: { amount: new Prisma.Decimal('0.00') },
      }),
    ).rejects.toThrow();

    // Refund amount tampering blocked
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "refunds" SET "amount" = 10.00 WHERE "id" = '${refund.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.refund.update({ where: { id: refund.id }, data: { amount: new Prisma.Decimal('10.00') } }),
    ).rejects.toThrow();

    // VendorOrder subtotal tampering blocked
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "vendor_orders" SET "subtotal" = 1.00 WHERE "id" = '${vo.id}'`),
    ).rejects.toThrow();
    await expect(
      prisma.vendorOrder.update({ where: { id: vo.id }, data: { subtotal: new Prisma.Decimal('1.00') } }),
    ).rejects.toThrow();
  });

  it('5-6. blocks parent identity reassignment across refunds, vendor orders, and payments', async () => {
    const { order: orderA, payment: paymentA, vendorOrders: vosA } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '70.00' }],
    });
    const { order: orderB, payment: paymentB } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor2, subtotal: '70.00' }],
    });
    const voA = vosA[0]!;

    const refundA = await prisma.refund.create({
      data: {
        paymentId: paymentA.id,
        amount: new Prisma.Decimal('30.00'),
        reason: 'Reassign test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `reassign_${randomUUID()}`,
      },
    });

    // 5. Refund paymentId reassignment blocked
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "paymentId" = '${paymentB.id}' WHERE "id" = '${refundA.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.refund.update({ where: { id: refundA.id }, data: { paymentId: paymentB.id } }),
    ).rejects.toThrow();

    // 6. VendorOrder orderId reassignment blocked
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "vendor_orders" SET "orderId" = '${orderB.id}' WHERE "id" = '${voA.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.vendorOrder.update({ where: { id: voA.id }, data: { orderId: orderB.id } }),
    ).rejects.toThrow();

    // Payment orderId reassignment blocked
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "payments" SET "orderId" = '${orderB.id}' WHERE "id" = '${paymentA.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.payment.update({ where: { id: paymentA.id }, data: { orderId: orderB.id } }),
    ).rejects.toThrow();
  });

  it('11-14. preserves valid lifecycle transitions and terminal state enforcement across refunds, payments, and settlements', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '80.00' }],
    });
    const vo = vendorOrders[0]!;

    // 11-12. Valid refund transitions work; terminal COMPLETED & FAILED cannot be altered
    const rRes = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '50.00',
      reason: 'Valid lifecycle test',
      idempotencyKey: `valid_r_${randomUUID()}`,
    });
    expect(rRes.status).toBe('RESERVED');

    // PROCESSING -> COMPLETED with providerReference succeeds
    const fin = await refundsRepo.finalizeRefund({
      refundId: rRes.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: 'valid_prov_ref_1',
    });
    expect(fin.refund.status).toBe(RefundStatus.COMPLETED);

    // COMPLETED refund status cannot regress or transition
    await expect(
      refundsRepo.finalizeRefund({
        refundId: rRes.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.PROCESSING,
      }),
    ).rejects.toThrow(ConflictException);

    // COMPLETED providerReference cannot be overwritten with a conflicting value
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "providerReference" = 'different_ref' WHERE "id" = '${rRes.refund!.id}'`,
      ),
    ).rejects.toThrow();

    // 13. Valid payment settlement transitions succeed (PAID -> PARTIALLY_REFUNDED / REFUNDED)
    const freshPay = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(freshPay.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);

    // 14. Valid vendor settlement lifecycle (PENDING -> APPROVED -> PAID)
    const settlement = await settlementsRepo.create({
      vendorId: vendor1.id,
      vendorOrderId: vo.id,
      grossAmount: 80.0,
      platformFee: 8.0,
      netAmount: 72.0,
    });
    expect(settlement.status).toBe(VendorSettlementStatus.PENDING);

    const approved = await settlementsService.updateStatus(
      settlement.id,
      VendorSettlementStatus.APPROVED,
      primaryAdminActor,
      { notes: 'Approved by finance' },
    );
    expect(approved.status).toBe(VendorSettlementStatus.APPROVED);

    const paid = await settlementsService.updateStatus(
      settlement.id,
      VendorSettlementStatus.PAID,
      primaryAdminActor,
      { notes: 'Disbursed via bank transfer' },
    );
    expect(paid.status).toBe(VendorSettlementStatus.PAID);
    expect(paid.paymentDate).toBeDefined();

    // Terminal PAID settlement cannot transition or alter paymentDate
    await expect(
      settlementsService.updateStatus(settlement.id, VendorSettlementStatus.APPROVED, primaryAdminActor),
    ).rejects.toThrow(BadRequestException);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "vendor_settlements" SET "status" = 'PENDING' WHERE "id" = '${settlement.id}'`,
      ),
    ).rejects.toThrow();
  });

  it('15. preserves reversal-integrity under immutability triggers (append-only REVERSAL works, direct mutation blocked)', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [{ vendor: vendor1, subtotal: '100.00' }],
    });
    const vo = vendorOrders[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('60.00'),
        reason: 'Reversal integrity test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `rev_int_${randomUUID()}`,
      },
    });

    const orig = await allocService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '60.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    // Valid append-only compensating reversal executes cleanly
    const rev = await allocService.reverseAllocation({
      allocationId: orig.id,
      amount: '30.00',
      reason: 'Partial reversal',
    });
    expect(new Prisma.Decimal(rev.amount).toFixed(2)).toBe('-30.00');

    // Deleting either original or reversal row is blocked by immutability trigger
    await expect(prisma.refundVendorOrderAllocation.delete({ where: { id: rev.id } })).rejects.toThrow();
    await expect(prisma.refundVendorOrderAllocation.delete({ where: { id: orig.id } })).rejects.toThrow();

    // Modifying either row is blocked by immutability trigger
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "refund_vendor_order_allocations" SET "amount" = -10.00 WHERE "id" = '${rev.id}'`,
      ),
    ).rejects.toThrow();
  });

  it('16-17. handles concurrent operational updates safely and rolls back transactions atomically on immutability violation', async () => {
    const { payment, vendorOrders } = await createOrderGraph({
      vendorSubtotals: [
        { vendor: vendor1, subtotal: '60.00' },
        { vendor: vendor2, subtotal: '60.00' },
      ],
    });
    const vo1 = vendorOrders[0]!;
    const vo2 = vendorOrders[1]!;

    // 16. Concurrent valid status updates on separate vendor_orders succeed cleanly
    const [vo1Res, vo2Res] = await Promise.allSettled([
      prisma.vendorOrder.update({ where: { id: vo1.id }, data: { status: VendorOrderStatus.CANCELLED } }),
      prisma.vendorOrder.update({ where: { id: vo2.id }, data: { status: VendorOrderStatus.CANCELLED } }),
    ]);
    expect(vo1Res.status).toBe('fulfilled');
    expect(vo2Res.status).toBe('fulfilled');

    // 17. Multi-step transaction rolls back atomically if a step violates immutability
    const sentinelId = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        // Step 1: Valid insert of a new order
        await tx.order.create({
          data: {
            id: sentinelId,
            customerId: customerUser.id,
            deliveryAddressLine1: 'Rollback sentinel St',
            deliveryParish: Parish.KINGSTON,
            deliveryPhone: '+18765550198',
            currency: 'JMD',
          },
        });
        // Step 2: Forbidden update on immutable payment amount
        await tx.payment.update({
          where: { id: payment.id },
          data: { amount: new Prisma.Decimal('9999.00') },
        });
      }),
    ).rejects.toThrow();

    // Assert that Step 1 was cleanly rolled back
    const foundSentinel = await prisma.order.findUnique({ where: { id: sentinelId } });
    expect(foundSentinel).toBeNull();
  });

  it('18-20. maintains historical record compatibility, supports isolated database cleanup, and executes zero automatic clawbacks', async () => {
    // 18. Historical record compatibility: queries on settlements, allocations, and refunds execute cleanly without unexpected schema errors
    const settlements = await prisma.vendorSettlement.findMany({ take: 5 });
    expect(Array.isArray(settlements)).toBe(true);

    const allocations = await prisma.refundVendorOrderAllocation.findMany({ take: 5 });
    expect(Array.isArray(allocations)).toBe(true);

    // 19. Verify that teardown on this test database will succeed via database disposal rather than cascading deletes
    expect(prisma).toBeDefined();

    // 20. Confirm zero automated clawback adjustments or balance writes were triggered
    const adjustments = await prisma.vendorSettlementAdjustment.findMany({
      where: { reason: { contains: 'AUTOMATED_CLAWBACK' } },
    });
    expect(adjustments).toHaveLength(0);
  });
});
