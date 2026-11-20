import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  Parish,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProductUnit,
  RefundAllocationEntryKind,
  RefundAllocationType,
  RefundStatus,
  User,
  Vendor,
  VendorOrder,
  VendorOrderStatus,
  OrderItem,
} from '@prisma/client';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { RefundsRepository } from '../../payments/repositories/refunds.repository';
import { RefundAllocationsRepository } from '../repositories/refund-allocations.repository';
import { RefundAllocationsService } from '../services/refund-allocations.service';

jest.setTimeout(120_000);

describe('D.4B.3 Allocation Eligibility, Option B Granularity, Hamilton Math & Concurrency (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let allocationsRepo: RefundAllocationsRepository;
  let allocationsService: RefundAllocationsService;
  let refundsRepo: RefundsRepository;

  let customerUser: User;
  let vendorUser1: User;
  let vendorUser2: User;
  let vendorUser3: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let vendor3: Vendor;
  let category: { id: string };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    allocationsRepo = new RefundAllocationsRepository(prisma);
    allocationsService = new RefundAllocationsService(prisma, allocationsRepo);
    refundsRepo = new RefundsRepository(prisma);

    category = await prisma.category.upsert({
      where: { slug: 'd4b3-seafood-cat' },
      update: {},
      create: {
        name: 'D4B3 Seafood Category',
        slug: 'd4b3-seafood-cat',
      },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `d4b3_cust_${randomUUID()}@example.com`,
        passwordHash: 'dummy_hash',
        firstName: 'Dana',
        lastName: 'Customer',
      },
    });

    const createVendor = async (suffix: string, parish: Parish) => {
      const user = await prisma.user.create({
        data: {
          email: `d4b3_v_${suffix}_${randomUUID()}@example.com`,
          passwordHash: 'dummy_hash',
          firstName: 'Vendor',
          lastName: suffix,
        },
      });
      const vendor = await prisma.vendor.create({
        data: {
          userId: user.id,
          businessName: `D4B3 Vendor ${suffix} ${randomUUID().slice(0, 6)}`,
          parish,
          termsAcceptedAt: new Date(),
        },
      });
      return { user, vendor };
    };

    const v1 = await createVendor('One', Parish.KINGSTON);
    const v2 = await createVendor('Two', Parish.ST_JAMES);
    const v3 = await createVendor('Three', Parish.ST_ANN);
    vendorUser1 = v1.user;
    vendor1 = v1.vendor;
    vendorUser2 = v2.user;
    vendor2 = v2.vendor;
    vendorUser3 = v3.user;
    vendor3 = v3.vendor;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createMultiItemOrderGraph(options: {
    vendorGroups: Array<{
      vendor: Vendor;
      explicitVoId?: string;
      items: Array<{ name: string; subtotal: string }>;
    }>;
    paymentStatus?: PaymentStatus;
    paymentAmount?: string;
  }): Promise<{
    order: { id: string };
    payment: { id: string; amount: Prisma.Decimal; status: PaymentStatus };
    vendorOrders: Array<VendorOrder & { items: OrderItem[] }>;
  }> {
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '10 Harbour St',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550100',
        currency: 'JMD',
      },
    });

    const vendorOrders: Array<VendorOrder & { items: OrderItem[] }> = [];
    let computedPaymentTotal = new Prisma.Decimal(0);

    for (const vg of options.vendorGroups) {
      const voSubtotal = vg.items.reduce(
        (acc, it) => acc.add(new Prisma.Decimal(it.subtotal)),
        new Prisma.Decimal(0),
      );
      computedPaymentTotal = computedPaymentTotal.add(voSubtotal);

      const createdItemsPayload: Array<{
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: Prisma.Decimal;
        unit: ProductUnit;
        subtotal: Prisma.Decimal;
        currency: string;
      }> = [];

      for (const itemSpec of vg.items) {
        const product = await prisma.product.create({
          data: {
            vendorId: vg.vendor.id,
            categoryId: category.id,
            name: `${itemSpec.name} ${randomUUID().slice(0, 6)}`,
            description: 'D4B3 test item',
            unit: ProductUnit.PER_ITEM,
            price: new Prisma.Decimal(itemSpec.subtotal),
            quantityAvailable: 100,
            imageUrl: 'https://example.com/fish.jpg',
          },
        });
        createdItemsPayload.push({
          productId: product.id,
          productName: product.name,
          quantity: 1,
          unitPrice: new Prisma.Decimal(itemSpec.subtotal),
          unit: product.unit,
          subtotal: new Prisma.Decimal(itemSpec.subtotal),
          currency: 'JMD',
        });
      }

      const vo = await prisma.vendorOrder.create({
        data: {
          ...(vg.explicitVoId ? { id: vg.explicitVoId } : {}),
          orderId: order.id,
          vendorId: vg.vendor.id,
          subtotal: voSubtotal,
          status: VendorOrderStatus.DELIVERED,
          items: { create: createdItemsPayload },
        },
        include: { items: true },
      });
      vendorOrders.push(vo);
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: PaymentProviderName.WIPAY,
        merchantAccountId: 'default',
        status: options.paymentStatus ?? PaymentStatus.PAID,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
        amount: options.paymentAmount
          ? new Prisma.Decimal(options.paymentAmount)
          : computedPaymentTotal,
        currency: 'JMD',
        providerReference: `prov_${randomUUID()}`,
      },
    });

    return { order, payment, vendorOrders };
  }

  // ---------------------------------------------------------------------------
  // 1. Valid allocation identity & component keys
  // ---------------------------------------------------------------------------
  it('1. establishes Option B allocation identity defaults (VO, COMP:*, ITEM:*) and composite unique lookup', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          items: [
            { name: 'Snapper', subtotal: '60.00' },
            { name: 'Lobster', subtotal: '40.00' },
          ],
        },
      ],
    });
    const vo = vendorOrders[0]!;
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Identity test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const defaultVoAlloc = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '25.00',
      allocationType: RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
    });
    expect(defaultVoAlloc.componentKey).toBe('VO');
    expect(defaultVoAlloc.entryKind).toBe(RefundAllocationEntryKind.ALLOCATION);
    expect(defaultVoAlloc.orderItemId).toBeNull();
    expect(defaultVoAlloc.reversesAllocationId).toBeNull();

    const compAlloc = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      componentKey: 'COMP:PACKAGING',
      amount: '15.00',
      allocationType: RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
    });
    expect(compAlloc.componentKey).toBe('COMP:PACKAGING');

    const fetchedDefault = await allocationsRepo.findUnique(
      refund.id,
      vo.id,
      RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
    );
    expect(fetchedDefault?.id).toBe(defaultVoAlloc.id);

    const fetchedComp = await allocationsRepo.findUnique(
      refund.id,
      vo.id,
      RefundAllocationType.MANUAL_SUPERVISOR_ADJUSTMENT,
      'COMP:PACKAGING',
    );
    expect(fetchedComp?.id).toBe(compAlloc.id);
  });

  // ---------------------------------------------------------------------------
  // 2 & 3. Multiple item-level allocations & duplicate identity / spoofing rejection
  // ---------------------------------------------------------------------------
  it('2. allows multiple distinct item allocations under same (refundId, vendorOrderId, allocationType) while rejecting duplicates and key spoofing', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          items: [
            { name: 'Snapper', subtotal: '40.00' },
            { name: 'Conch', subtotal: '60.00' },
          ],
        },
        {
          vendor: vendor2,
          items: [{ name: 'Tuna', subtotal: '50.00' }],
        },
      ],
    });
    const vo1 = vendorOrders[0]!;
    const itemA = vo1.items[0]!;
    const itemB = vo1.items[1]!;
    const foreignItem = vendorOrders[1]!.items[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Multi-item defect refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const a1 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo1.id,
      orderItemId: itemA.id,
      amount: '30.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });
    const a2 = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo1.id,
      orderItemId: itemB.id,
      amount: '45.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });

    expect(a1.componentKey).toBe(`ITEM:${itemA.id}`);
    expect(a2.componentKey).toBe(`ITEM:${itemB.id}`);

    // Duplicate logical item allocation rejects with P2002
    let dupErr: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo1.id,
        orderItemId: itemA.id,
        amount: '5.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      });
    } catch (e) {
      dupErr = e;
    }
    expect(dupErr?.code).toBe('P2002');

    // Cross-VO item ownership rejected
    await expect(
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo1.id,
        orderItemId: foreignItem.id,
        amount: '10.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ).rejects.toThrow(BadRequestException);

    // Key spoofing ('REV:*' or 'ITEM:*' without orderItemId) rejected
    await expect(
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo1.id,
        componentKey: 'REV:fake-id',
        amount: '5.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      allocationsService.createAllocation({
        refundId: refund.id,
        vendorOrderId: vo1.id,
        componentKey: `ITEM:${itemA.id}`,
        amount: '5.00',
        allocationType: RefundAllocationType.CUSTOMER_RETURN,
      }),
    ).rejects.toThrow(BadRequestException);

    // Per-item ceiling enforcement on second refund for same item (itemA subtotal 40 - 30 = 10 left)
    const refund2 = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('20.00'),
        reason: 'Follow-up refund',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await expect(
      allocationsService.createAllocation({
        refundId: refund2.id,
        vendorOrderId: vo1.id,
        orderItemId: itemA.id,
        amount: '15.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ---------------------------------------------------------------------------
  // 3, 4 & 5. Original + Reversal coexistence, duplicate reversal rejection, reversal ceilings & DB CHECK guards
  // ---------------------------------------------------------------------------
  it('3. allows original ALLOCATION and REVERSAL coexistence, enforces single reversal, reversal ceiling, and PostgreSQL CHECK constraints', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          items: [{ name: 'Mackerel', subtotal: '80.00' }],
        },
      ],
    });
    const vo = vendorOrders[0]!;
    const item = vo.items[0]!;

    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('80.00'),
        reason: 'Reversal lifecycle test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    const orig = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      orderItemId: item.id,
      amount: '50.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    // Reject over-reversal (> 50.00)
    await expect(
      allocationsService.reverseAllocation({
        allocationId: orig.id,
        amount: '55.00',
        reason: 'Over-reversal attempt',
      }),
    ).rejects.toThrow(BadRequestException);

    // Concurrent reversal attempts: lock serializes workers so 1 succeeds and 1 rejects with ConflictException
    const raceResults = await Promise.allSettled([
      allocationsService.reverseAllocation({
        allocationId: orig.id,
        amount: '50.00',
        reason: 'Valid reversal A',
      }),
      allocationsService.reverseAllocation({
        allocationId: orig.id,
        amount: '50.00',
        reason: 'Valid reversal B',
      }),
    ]);

    const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
    const rejected = raceResults.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const rev = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(rev.entryKind).toBe(RefundAllocationEntryKind.REVERSAL);
    expect(rev.componentKey).toBe(`REV:${orig.id}`);
    expect(rev.reversesAllocationId).toBe(orig.id);
    expect(new Prisma.Decimal(rev.amount).toFixed(2)).toBe('-50.00');
    expect(rev.orderItemId).toBe(item.id);

    // Sequential second reversal also rejected cleanly with ConflictException
    await expect(
      allocationsService.reverseAllocation({
        allocationId: orig.id,
        reason: 'Third reversal',
      }),
    ).rejects.toThrow(ConflictException);

    // Direct repository bypass attempting a second REVERSAL referencing the same reversesAllocationId hits PostgreSQL P2002 (reversesAllocationId_key)
    let repoDupErr: any = null;
    try {
      await allocationsRepo.create({
        refundId: refund.id,
        vendorOrderId: vo.id,
        orderItemId: item.id,
        componentKey: `REV:${orig.id}`,
        entryKind: RefundAllocationEntryKind.REVERSAL,
        reversesAllocationId: orig.id,
        amount: '-1.00',
        allocationType: RefundAllocationType.CANCELLATION,
        reason: 'Bypass duplicate reversal unique index test',
      });
    } catch (e) {
      repoDupErr = e;
    }
    expect(repoDupErr?.code).toBe('P2002');

    // Reversing a REVERSAL entry rejected cleanly
    await expect(
      allocationsService.reverseAllocation({
        allocationId: rev.id,
        reason: 'Cannot reverse a reversal',
      }),
    ).rejects.toThrow(BadRequestException);

    // Net refund, VO, and OrderItem liabilities are all 0.00
    expect((await allocationsRepo.sumByRefundIdDecimal(refund.id)).toFixed(2)).toBe('0.00');
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo.id)).toFixed(2)).toBe('0.00');
    expect((await allocationsRepo.sumByOrderItemIdDecimal(item.id)).toFixed(2)).toBe('0.00');

    // Re-allocating after full reversal succeeds without colliding on uniqueness
    const reAlloc = await allocationsService.createAllocation({
      refundId: refund.id,
      vendorOrderId: vo.id,
      amount: '40.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });
    expect(new Prisma.Decimal(reAlloc.amount).toFixed(2)).toBe('40.00');

    // DB CHECK constraints reject raw SQL bypasses
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id", "refundId", "vendorOrderId", "componentKey", "entryKind", "reversesAllocationId", "amount", "currency", "allocationType")
        VALUES ('${randomUUID()}', '${refund.id}', '${vo.id}', 'REV:${reAlloc.id}', 'REVERSAL', '${reAlloc.id}', 10.00, 'JMD', 'CANCELLATION')
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id", "refundId", "vendorOrderId", "componentKey", "entryKind", "reversesAllocationId", "amount", "currency", "allocationType")
        VALUES ('${randomUUID()}', '${refund.id}', '${vo.id}', 'COMP:BAD', 'ALLOCATION', NULL, -10.00, 'JMD', 'CANCELLATION')
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "refund_vendor_order_allocations"
          ("id", "refundId", "vendorOrderId", "componentKey", "entryKind", "reversesAllocationId", "amount", "currency", "allocationType")
        VALUES ('${randomUUID()}', '${refund.id}', '${vo.id}', '   ', 'ALLOCATION', NULL, 10.00, 'JMD', 'CANCELLATION')
      `),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 6, 7 & 8. Refund eligibility lifecycle: FAILED rejection, provisional retention, reconciliation, retry freedom
  // ---------------------------------------------------------------------------
  it('4. enforces RefundStatus eligibility (allows REQUIRED/PENDING/PROCESSING/RECONCILE_REQUIRED/COMPLETED, rejects FAILED, and frees capacity on FAILED transition without deleting audit evidence)', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [{ vendor: vendor1, items: [{ name: 'Parrotfish', subtotal: '75.00' }] }],
    });
    const vo = vendorOrders[0]!;

    // 4a. Direct FAILED refund rejection
    const failedRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('75.00'),
        reason: 'Failed gateway call',
        status: RefundStatus.FAILED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });
    await expect(
      allocationsService.createAllocation({
        refundId: failedRefund.id,
        vendorOrderId: vo.id,
        amount: '75.00',
        allocationType: RefundAllocationType.CANCELLATION,
      }),
    ).rejects.toThrow(BadRequestException);

    // 4b. All 4 provisional statuses accept allocation creation
    for (const status of [
      RefundStatus.REQUIRED,
      RefundStatus.PENDING,
      RefundStatus.PROCESSING,
      RefundStatus.RECONCILE_REQUIRED,
    ]) {
      const provRefund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          amount: new Prisma.Decimal('10.00'),
          reason: `Provisional ${status}`,
          status,
          idempotencyKey: `ref_${randomUUID()}`,
        },
      });
      const alloc = await allocationsService.createAllocation({
        refundId: provRefund.id,
        vendorOrderId: vo.id,
        amount: '10.00',
        allocationType: RefundAllocationType.CUSTOMER_RETURN,
      });
      expect(alloc.refundId).toBe(provRefund.id);

      // Reconcile/fail provisional refund to free VO capacity cleanly for next iteration
      await prisma.refund.update({
        where: { id: provRefund.id },
        data: { status: RefundStatus.FAILED },
      });

      // Historical provisional allocation row MUST remain intact in audit log
      const historicalRows = await allocationsRepo.findByRefundId(provRefund.id);
      expect(historicalRows).toHaveLength(1);
    }

    // 4c. After 4 provisional-then-FAILED refunds (40.00 historical failed), active VO sum is 0.00 -> retry refund R2 takes full 75.00!
    expect((await allocationsRepo.sumByVendorOrderIdDecimal(vo.id)).toFixed(2)).toBe('0.00');
    expect(
      (await allocationsRepo.sumByVendorOrderIdDecimal(vo.id, undefined, { includeFailed: true })).toFixed(2),
    ).toBe('40.00');

    // 4d. Provider uncertainty RECONCILE_REQUIRED -> provisional 30.00 -> COMPLETED -> no capacity duplication, remaining 45.00 allocates
    const uncertainRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('75.00'),
        reason: 'Timeout then reconciled completed',
        status: RefundStatus.RECONCILE_REQUIRED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });
    await allocationsService.createAllocation({
      refundId: uncertainRefund.id,
      vendorOrderId: vo.id,
      amount: '30.00',
      allocationType: RefundAllocationType.CANCELLATION,
    });

    await prisma.refund.update({
      where: { id: uncertainRefund.id },
      data: { status: RefundStatus.COMPLETED, providerReference: `recon_${randomUUID()}` },
    });

    // Re-allocating the same key after COMPLETED still rejects with P2002 (never duplicates)
    let replayErr: any = null;
    try {
      await allocationsService.createAllocation({
        refundId: uncertainRefund.id,
        vendorOrderId: vo.id,
        amount: '30.00',
        allocationType: RefundAllocationType.CANCELLATION,
      });
    } catch (e) {
      replayErr = e;
    }
    expect(replayErr?.code).toBe('P2002');

    // Exceeding remaining 45.00 balance rejected cleanly
    await expect(
      allocationsService.createAllocation({
        refundId: uncertainRefund.id,
        vendorOrderId: vo.id,
        amount: '50.00',
        allocationType: RefundAllocationType.ITEM_DEFECT,
      }),
    ).rejects.toThrow(BadRequestException);

    // Allocating exact remaining 45.00 succeeds
    await allocationsService.createAllocation({
      refundId: uncertainRefund.id,
      vendorOrderId: vo.id,
      amount: '45.00',
      allocationType: RefundAllocationType.ITEM_DEFECT,
    });
    expect((await allocationsRepo.sumByRefundIdDecimal(uncertainRefund.id)).toFixed(2)).toBe('75.00');
  });

  // ---------------------------------------------------------------------------
  // 9. Strict 2-decimal-place rejection
  // ---------------------------------------------------------------------------
  it('5. strictly rejects sub-cent inputs (> 2dp) without silent rounding at both service and repository boundaries', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [{ vendor: vendor1, items: [{ name: 'Kingfish', subtotal: '100.00' }] }],
    });
    const vo = vendorOrders[0]!;
    const refund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('100.00'),
        reason: '2dp test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    for (const badAmount of ['10.004', '10.005', 10.004, 0.1 + 0.2]) {
      await expect(
        allocationsService.createAllocation({
          refundId: refund.id,
          vendorOrderId: vo.id,
          amount: badAmount,
          allocationType: RefundAllocationType.CANCELLATION,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        allocationsRepo.create({
          refundId: refund.id,
          vendorOrderId: vo.id,
          amount: badAmount,
          allocationType: RefundAllocationType.CANCELLATION,
        }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  // ---------------------------------------------------------------------------
  // 10, 11 & 12. Hamilton PostgreSQL exact conservation, tie-break determinism & order independence
  // ---------------------------------------------------------------------------
  it('6. persists deterministic Hamilton integer-cent splits in PostgreSQL independent of target input ordering', async () => {
    const voIdHigh = 'ffffffff-0000-4000-8000-000000000003';
    const voIdMid = '88888888-0000-4000-8000-000000000002';
    const voIdLow = '11111111-0000-4000-8000-000000000001';

    const { payment: p1, vendorOrders: vos1 } = await createMultiItemOrderGraph({
      vendorGroups: [
        { vendor: vendor1, explicitVoId: `${voIdHigh.slice(0, 24)}${randomUUID().slice(24)}`, items: [{ name: 'A', subtotal: '33.34' }] },
        { vendor: vendor2, explicitVoId: `${voIdMid.slice(0, 24)}${randomUUID().slice(24)}`, items: [{ name: 'B', subtotal: '33.34' }] },
        { vendor: vendor3, explicitVoId: `${voIdLow.slice(0, 24)}${randomUUID().slice(24)}`, items: [{ name: 'C', subtotal: '33.34' }] },
      ],
      paymentAmount: '100.02',
    });
    const sortedIds1 = vos1.map((v) => v.id).sort();
    const refund1 = await prisma.refund.create({
      data: {
        paymentId: p1.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Equal 3-way split',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    // Pass reversed/unsorted targets deliberately
    const res1 = await allocationsService.createProportionalAllocations({
      refundId: refund1.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      targets: [
        { vendorOrderId: sortedIds1[2]!, weight: '33.33' },
        { vendorOrderId: sortedIds1[0]!, weight: '33.33' },
        { vendorOrderId: sortedIds1[1]!, weight: '33.33' },
      ],
    });

    expect(res1.allocations).toHaveLength(3);
    expect(res1.distribution.allocatedAmount.toFixed(2)).toBe('100.00');
    // Lowest vendorOrderId ASC gets extra $0.01
    expect(res1.allocations.find((a) => a.vendorOrderId === sortedIds1[0])?.amount.toFixed(2)).toBe('33.34');
    expect(res1.allocations.find((a) => a.vendorOrderId === sortedIds1[1])?.amount.toFixed(2)).toBe('33.33');
    expect(res1.allocations.find((a) => a.vendorOrderId === sortedIds1[2])?.amount.toFixed(2)).toBe('33.33');

    // Separate refund on mirrored order with reversed target enumeration order produces identical distribution
    const refund2 = await prisma.refund.create({
      data: {
        paymentId: p1.id,
        amount: new Prisma.Decimal('100.00'),
        reason: 'Second mirror refund to compare inside tx rollback',
        status: RefundStatus.PENDING,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });
    // Use item sub-capacities cleanly after reversing res1's allocations
    for (const a of res1.allocations) {
      await allocationsService.reverseAllocation({
        allocationId: a.id,
        reason: 'Reset before mirror input order check',
      });
    }
    const res2 = await allocationsService.createProportionalAllocations({
      refundId: refund2.id,
      amount: '100.00',
      allocationType: RefundAllocationType.CANCELLATION,
      targets: [
        { vendorOrderId: sortedIds1[1]!, weight: '33.33' },
        { vendorOrderId: sortedIds1[2]!, weight: '33.33' },
        { vendorOrderId: sortedIds1[0]!, weight: '33.33' },
      ],
    });
    expect(res2.allocations.map((a) => ({ vo: a.vendorOrderId, amt: a.amount.toFixed(2) }))).toEqual(
      res1.allocations.map((a) => ({ vo: a.vendorOrderId, amt: a.amount.toFixed(2) })),
    );
  });

  // ---------------------------------------------------------------------------
  // 13, 14, 15 & 16. Multi-vendor concurrency, same-vendor concurrency, SQL lock-order trace & finalizeRefund serialization + rollback
  // ---------------------------------------------------------------------------
  it('7. executes canonical Order -> VendorOrder ASC -> [Payment] -> Refund lock order, serializes concurrent multi-vendor/same-vendor workers with 0 deadlocks, and rolls back cleanly', async () => {
    const { payment, vendorOrders } = await createMultiItemOrderGraph({
      vendorGroups: [
        { vendor: vendor1, items: [{ name: 'VO1', subtotal: '50.00' }] },
        { vendor: vendor2, items: [{ name: 'VO2', subtotal: '50.00' }] },
      ],
    });
    const sortedVos = [...vendorOrders].sort((a, b) => (a.id < b.id ? -1 : 1));
    const voA = sortedVos[0]!;
    const voB = sortedVos[1]!;

    // 7a. Capture actual PostgreSQL FOR UPDATE query sequence via dedicated logged PrismaClient
    const loggedPrisma = new PrismaClient({
      log: [{ emit: 'event', level: 'query' }],
    });
    await loggedPrisma.$connect();
    const capturedForUpdateSql: string[] = [];
    (loggedPrisma as any).$on('query', (e: { query: string }) => {
      if (e.query.toUpperCase().includes('FOR UPDATE')) {
        capturedForUpdateSql.push(e.query);
      }
    });

    const loggedRepo = new RefundAllocationsRepository(loggedPrisma as unknown as PrismaService);
    const loggedService = new RefundAllocationsService(
      loggedPrisma as unknown as PrismaService,
      loggedRepo,
    );
    const loggedRefundsRepo = new RefundsRepository(loggedPrisma as unknown as PrismaService);

    const traceRefund = await loggedPrisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('40.00'),
        reason: 'Lock order spy test',
        status: RefundStatus.PROCESSING,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    // Deliberately pass inverted [voB, voA]
    await loggedService.createBatchAllocations({
      refundId: traceRefund.id,
      items: [
        {
          vendorOrderId: voB.id,
          amount: '20.00',
          allocationType: RefundAllocationType.CANCELLATION,
        },
        {
          vendorOrderId: voA.id,
          amount: '20.00',
          allocationType: RefundAllocationType.CANCELLATION,
        },
      ],
    });

    expect(capturedForUpdateSql).toHaveLength(4);
    expect(capturedForUpdateSql[0]).toContain('FROM "orders"');
    expect(capturedForUpdateSql[1]).toContain('FROM "vendor_orders"');
    expect(capturedForUpdateSql[1]).toContain('ORDER BY "id" ASC FOR UPDATE');
    expect(capturedForUpdateSql[2]).toContain('FROM "payments"');
    expect(capturedForUpdateSql[3]).toContain('FROM "refunds"');

    // Verify finalizeRefund SQL FOR UPDATE sequence: Order -> VendorOrders ASC -> Payment -> RefundObligations ASC -> Refunds ASC -> RefundProviderAttempts ASC
    capturedForUpdateSql.length = 0;
    await loggedRefundsRepo.finalizeRefund({
      refundId: traceRefund.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: `fin_${randomUUID()}`,
      expectedAmount: '40.00',
    });

    expect(capturedForUpdateSql).toHaveLength(6);
    expect(capturedForUpdateSql[0]).toContain('FROM "orders"');
    expect(capturedForUpdateSql[1]).toContain('FROM "vendor_orders"');
    expect(capturedForUpdateSql[1]).toContain('ORDER BY "id" ASC FOR UPDATE');
    expect(capturedForUpdateSql[2]).toContain('FROM "payments"');
    expect(capturedForUpdateSql[3]).toContain('FROM "refund_obligations"');
    expect(capturedForUpdateSql[3]).toContain('ORDER BY "id" ASC FOR UPDATE');
    expect(capturedForUpdateSql[4]).toContain('FROM "refunds"');
    expect(capturedForUpdateSql[4]).toContain('ORDER BY "id" ASC FOR UPDATE');
    expect(capturedForUpdateSql[5]).toContain('FROM "refund_provider_attempts"');
    expect(capturedForUpdateSql[5]).toContain('ORDER BY "id" ASC FOR UPDATE');
    await loggedPrisma.$disconnect();

    // 7b. Concurrency stress test: finalizeRefund vs inverted multi-vendor batch allocations vs single-VO allocations
    const rA = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('30.00'),
        reason: 'Concurrent race A',
        status: RefundStatus.PROCESSING,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });
    const rB = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('30.00'),
        reason: 'Concurrent race B',
        status: RefundStatus.PROCESSING,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    // Both try to take full remaining 30.00 from voA (voA has 50 - 20 = 30.00 left) while finalizeRefund competes on Order/Payment
    const concurrentOutcomes = await Promise.allSettled([
      allocationsService.createBatchAllocations({
        refundId: rA.id,
        items: [
          { vendorOrderId: voB.id, amount: '0.01', allocationType: RefundAllocationType.ITEM_DEFECT },
          { vendorOrderId: voA.id, amount: '29.99', allocationType: RefundAllocationType.ITEM_DEFECT },
        ],
      }),
      allocationsService.createBatchAllocations({
        refundId: rB.id,
        items: [
          { vendorOrderId: voA.id, amount: '29.99', allocationType: RefundAllocationType.CUSTOMER_RETURN },
          { vendorOrderId: voB.id, amount: '0.01', allocationType: RefundAllocationType.CUSTOMER_RETURN },
        ],
      }),
      refundsRepo.finalizeRefund({
        refundId: rA.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: `conc_a_${randomUUID()}`,
      }),
      refundsRepo.finalizeRefund({
        refundId: rB.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: `conc_b_${randomUUID()}`,
      }),
    ]);

    for (const outcome of concurrentOutcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason?.code).not.toBe('40P01');
      }
    }
    const finalVoASum = await allocationsRepo.sumByVendorOrderIdDecimal(voA.id);
    expect(finalVoASum.lte(new Prisma.Decimal('50.00'))).toBe(true);

    // 7c. Batch transaction rollback on mid-batch failure preserves zero partial rows
    const rollbackRefund = await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amount: new Prisma.Decimal('20.00'),
        reason: 'Batch rollback test',
        status: RefundStatus.COMPLETED,
        idempotencyKey: `ref_${randomUUID()}`,
      },
    });

    await expect(
      allocationsService.createBatchAllocations({
        refundId: rollbackRefund.id,
        items: [
          {
            vendorOrderId: voB.id,
            amount: '10.00',
            allocationType: RefundAllocationType.ITEM_DEFECT,
          },
          {
            vendorOrderId: voB.id,
            amount: '10.00',
            allocationType: RefundAllocationType.ITEM_DEFECT, // Duplicate key triggers P2002 mid-batch
          },
        ],
      }),
    ).rejects.toThrow();

    expect(await allocationsRepo.findByRefundId(rollbackRefund.id)).toHaveLength(0);
    expect((await allocationsRepo.sumByRefundIdDecimal(rollbackRefund.id)).toFixed(2)).toBe('0.00');
  });

  // ---------------------------------------------------------------------------
  // 17. B-02 reserveRefund & finalizeRefund non-regression verification with fixed lock order
  // ---------------------------------------------------------------------------
  it('8. preserves B-02 reserveRefund idempotency, COMPLETED status guards, and single-dispatch uncertainty guarantees under corrected finalizeRefund locks', async () => {
    const { payment } = await createMultiItemOrderGraph({
      vendorGroups: [{ vendor: vendor1, items: [{ name: 'Snapper B02', subtotal: '90.00' }] }],
    });
    const idemKey = `b02_lock_${randomUUID()}`;

    const res = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'B02 regression check',
      idempotencyKey: idemKey,
    });
    expect(res.status).toBe('RESERVED');

    const fin = await refundsRepo.finalizeRefund({
      refundId: res.refund!.id,
      paymentId: payment.id,
      status: RefundStatus.COMPLETED,
      providerReference: `b02_ref_${randomUUID()}`,
      expectedAmount: '40.00',
    });
    expect(fin.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(fin.totalRefunded.toFixed(2)).toBe('40.00');

    // Duplicate reserve with same key must return ALREADY_COMPLETED
    const replay = await refundsRepo.reserveRefund({
      paymentId: payment.id,
      amount: '40.00',
      reason: 'B02 regression check',
      idempotencyKey: idemKey,
    });
    expect(replay.status).toBe('ALREADY_COMPLETED');

    // Finalizing with conflicting providerReference must still throw ConflictException
    await expect(
      refundsRepo.finalizeRefund({
        refundId: res.refund!.id,
        paymentId: payment.id,
        status: RefundStatus.COMPLETED,
        providerReference: 'different_provider_ref',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
