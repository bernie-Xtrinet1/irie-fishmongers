import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Parish,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  ProductUnit,
  RefundStatus,
  RoleName,
  SeafoodStorageType,
  VendorOrderStatus,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import { InventoryEventsRepository } from '../../../inventory/repositories/inventory-events.repository';
import { CashOnDeliveryAdapter } from '../../../payments/providers/cash-on-delivery.adapter';
import { WiPayAdapter, WIPAY_SANDBOX_API_URL } from '../../../payments/providers/wipay.adapter';
import { PaymentsRepository } from '../../../payments/repositories/payments.repository';
import { RefundsRepository } from '../../../payments/repositories/refunds.repository';
import { PaymentsService } from '../../../payments/services/payments.service';
import { ProductsRepository } from '../../../products/repositories/products.repository';
import { VendorsRepository } from '../../../vendors/repositories/vendors.repository';
import { OrdersRepository } from '../../repositories/orders.repository';
import { VendorOrdersRepository } from '../../repositories/vendor-orders.repository';
import { OrdersService } from '../orders.service';
import { VendorOrdersService } from '../vendor-orders.service';

jest.setTimeout(120_000);

describe('D.4B.6A Workstream A - Atomic Paid Vendor-Order Rejection (PostgreSQL Suite)', () => {
  let prisma: PrismaService;
  let ordersRepo: OrdersRepository;
  let vendorOrdersRepo: VendorOrdersRepository;
  let productsRepo: ProductsRepository;
  let vendorsRepo: VendorsRepository;
  let inventoryEventsRepo: InventoryEventsRepository;
  let paymentsRepo: PaymentsRepository;
  let refundsRepo: RefundsRepository;
  let wiPayAdapter: WiPayAdapter;
  let codAdapter: CashOnDeliveryAdapter;
  let paymentsService: PaymentsService;
  let ordersService: OrdersService;
  let vendorOrdersService: VendorOrdersService;
  let eventEmitter: EventEmitter2;

  let customerUserId: string;
  let vendorUser1Id: string;
  let vendorUser2Id: string;
  let vendor1Id: string;
  let vendor2Id: string;
  let categoryId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    ordersRepo = new OrdersRepository(prisma);
    vendorOrdersRepo = new VendorOrdersRepository(prisma);
    productsRepo = new ProductsRepository(prisma);
    vendorsRepo = new VendorsRepository(prisma);
    inventoryEventsRepo = new InventoryEventsRepository(prisma);
    paymentsRepo = new PaymentsRepository(prisma);
    refundsRepo = new RefundsRepository(prisma);

    const config = new ConfigService({
      WIPAY_API_URL: WIPAY_SANDBOX_API_URL,
      WIPAY_ACCOUNT_NUMBER: '1234567890',
      WIPAY_API_KEY: 'test-wipay-key',
      WIPAY_FEE_STRUCTURE: 'merchant_absorb',
      APP_BASE_URL: 'http://localhost:3001',
      API_PREFIX: 'api/v1',
    });
    wiPayAdapter = new WiPayAdapter(config);
    codAdapter = new CashOnDeliveryAdapter();
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) } as unknown as EventEmitter2;

    paymentsService = new PaymentsService(
      paymentsRepo,
      refundsRepo,
      wiPayAdapter,
      codAdapter,
      eventEmitter,
    );

    ordersService = new OrdersService(
      prisma,
      ordersRepo,
      vendorOrdersRepo,
      {} as any,
      productsRepo,
      vendorsRepo,
      paymentsService,
      {} as any,
      inventoryEventsRepo,
      {} as any,
      eventEmitter,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      config,
    );

    vendorOrdersService = new VendorOrdersService(
      prisma,
      vendorOrdersRepo,
      vendorsRepo,
      productsRepo,
      paymentsService,
      inventoryEventsRepo,
      eventEmitter,
    );

    for (const roleName of [RoleName.CUSTOMER, RoleName.VENDOR]) {
      await prisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName },
      });
    }
    const customerRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.CUSTOMER } });
    const vendorRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.VENDOR } });

    const customer = await prisma.user.create({
      data: {
        email: `d4b6a-cust-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'Cara',
        lastName: 'Customer',
        roles: { create: { roleId: customerRole.id } },
      },
    });
    customerUserId = customer.id;

    const u1 = await prisma.user.create({
      data: {
        email: `d4b6a-v1-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'V1',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });
    vendorUser1Id = u1.id;

    const u2 = await prisma.user.create({
      data: {
        email: `d4b6a-v2-${randomUUID()}@example.com`,
        passwordHash: 'hash',
        firstName: 'V2',
        lastName: 'Vendor',
        roles: { create: { roleId: vendorRole.id } },
      },
    });
    vendorUser2Id = u2.id;

    const v1 = await prisma.vendor.create({
      data: {
        userId: vendorUser1Id,
        businessName: `D4B6A Fishery 1 ${randomUUID().slice(0, 6)}`,
        parish: Parish.KINGSTON,
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    vendor1Id = v1.id;

    const v2 = await prisma.vendor.create({
      data: {
        userId: vendorUser2Id,
        businessName: `D4B6A Fishery 2 ${randomUUID().slice(0, 6)}`,
        parish: Parish.ST_ANDREW,
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });
    vendor2Id = v2.id;

    const cat = await prisma.category.upsert({
      where: { slug: 'd4b6a-workstream-a-cat' },
      update: {},
      create: {
        name: 'D4B6A Workstream A Category',
        slug: 'd4b6a-workstream-a-cat',
      },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  async function seedOrderWithPayment(params: {
    vendors: Array<{
      vendorId: string;
      subtotal: string;
      quantity?: number;
      catchWeight?: { expired?: boolean; lotSafety?: FoodSafetyStatus };
    }>;
    payment?: {
      provider: PaymentProviderName;
      status: PaymentStatus;
      amount: string;
    } | null;
  }) {
    const order = await prisma.order.create({
      data: {
        customerId: customerUserId,
        deliveryAddressLine1: '12 Harbour Rd',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '+18765550101',
        currency: 'JMD',
      },
    });

    const createdVos: Array<{
      vendorOrderId: string;
      productId: string;
      listingId: string | null;
      initialProductQty: number;
    }> = [];

    for (const v of params.vendors) {
      const qty = v.quantity ?? 2;
      const initialQty = 10;
      const unitPrice = new Prisma.Decimal(v.subtotal).div(qty);

      let lotId: string | null = null;
      let catalogueItemId: string | null = null;
      if (v.catchWeight) {
        const catItem = await prisma.seafoodCatalogueItem.create({
          data: {
            name: `Snapper ${randomUUID().slice(0, 6)}`,
            commonName: 'Red Snapper',
            categoryId,
            lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
          },
        });
        const lot = await prisma.seafoodLot.create({
          data: {
            lotNumber: `LOT-${randomUUID().slice(0, 8)}`,
            vendorId: v.vendorId,
            species: 'Red Snapper',
            storageType: SeafoodStorageType.FRESH,
            catchDate: new Date(),
            weight: new Prisma.Decimal('100.00'),
            weightUnit: WeightUnit.POUNDS,
            foodSafetyStatus: v.catchWeight.lotSafety ?? FoodSafetyStatus.SAFE,
          },
        });
        catalogueItemId = catItem.id;
        lotId = lot.id;
      }

      const product = await prisma.product.create({
        data: {
          vendorId: v.vendorId,
          categoryId,
          lotId,
          catalogueItemId,
          name: `Fish ${randomUUID().slice(0, 6)}`,
          description: 'Workstream A test item',
          unit: ProductUnit.PER_POUND,
          price: unitPrice,
          quantityAvailable: initialQty,
          imageUrl: 'https://example.com/fish.jpg',
        },
      });

      let listingId: string | null = null;
      if (v.catchWeight) {
        const listing = await prisma.vendorDailyListing.create({
          data: {
            vendorId: v.vendorId,
            productId: product.id,
            catalogueItemId: catalogueItemId!,
            lotId: lotId!,
            listingTitle: `Listing ${randomUUID().slice(0, 6)}`,
            catchDate: new Date(),
            expiresAt: v.catchWeight.expired
              ? new Date(Date.now() - 86_400_000)
              : new Date(Date.now() + 86_400_000),
            unit: ProductUnit.PER_POUND,
            price: unitPrice,
            quantityUploaded: new Prisma.Decimal('20.00'),
            quantityAvailable: new Prisma.Decimal('10.00'),
            quantityReserved: new Prisma.Decimal('0.00'),
            quantitySold: new Prisma.Decimal(qty.toFixed(2)),
            status: ListingLifecycleStatus.PUBLISHED,
          },
        });
        listingId = listing.id;
        await prisma.listingPhoto.create({
          data: {
            vendorDailyListingId: listing.id,
            url: 'https://example.com/p.jpg',
            isPrimary: true,
            moderationStatus: ListingPhotoModerationStatus.APPROVED,
          },
        });
      }

      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: v.vendorId,
          status: VendorOrderStatus.PENDING,
          subtotal: new Prisma.Decimal(v.subtotal),
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                unitPrice,
                unit: ProductUnit.PER_POUND,
                quantity: qty,
                subtotal: new Prisma.Decimal(v.subtotal),
                currency: 'JMD',
                originalLotId: lotId,
                originalListingId: listingId,
              },
            ],
          },
        },
      });

      createdVos.push({
        vendorOrderId: vo.id,
        productId: product.id,
        listingId,
        initialProductQty: initialQty,
      });
    }

    let payment: { id: string } | null = null;
    if (params.payment) {
      const p = await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: params.payment.provider,
          status: params.payment.status,
          initiationStatus: PaymentInitiationStatus.ESTABLISHED,
          amount: new Prisma.Decimal(params.payment.amount),
          currency: 'JMD',
          providerReference: `ref-${randomUUID().slice(0, 8)}`,
          paidAt: params.payment.status === PaymentStatus.PAID ? new Date() : null,
        },
      });
      payment = { id: p.id };
    }

    return { orderId: order.id, paymentId: payment?.id ?? null, vendorOrders: createdVos };
  }

  it('1. Failure injection BEFORE transaction commit rolls back VendorOrder status, inventory restoration, and Refund creation atomically', async () => {
    const seeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '120.00', quantity: 3 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '120.00' },
    });
    const vo = seeded.vendorOrders[0]!;

    const origTx = prisma.$transaction.bind(prisma);
    const txSpy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(async (cb: any, opts?: any) => {
      return origTx(async (tx: any) => {
        const proxyTx = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'refund') {
              return {
                findUnique: target.refund.findUnique.bind(target.refund),
                findMany: target.refund.findMany.bind(target.refund),
                create: async () => {
                  throw new Error('INJECTED_BEFORE_COMMIT_REFUND_FAILURE');
                },
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return cb(proxyTx);
      }, opts);
    });

    await expect(vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId)).rejects.toThrow(
      'INJECTED_BEFORE_COMMIT_REFUND_FAILURE',
    );
    txSpy.mockRestore();

    const storedVo = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vo.vendorOrderId } });
    expect(storedVo.status).toBe(VendorOrderStatus.PENDING);

    const storedProduct = await prisma.product.findUniqueOrThrow({ where: { id: vo.productId } });
    expect(storedProduct.quantityAvailable).toBe(vo.initialProductQty);

    const events = await prisma.inventoryEvent.findMany({ where: { vendorOrderId: vo.vendorOrderId } });
    expect(events).toHaveLength(0);

    const refunds = await prisma.refund.findMany({ where: { paymentId: seeded.paymentId! } });
    expect(refunds).toHaveLength(0);
  });

  it('2. Failure injection DURING PostgreSQL COMMIT (DEFERRABLE INITIALLY DEFERRED trigger) rolls back rejection, stock restoration, and Refund together', async () => {
    const seeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '85.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '85.00' },
    });
    const vo = seeded.vendorOrders[0]!;
    const targetIdemKey = `refund_vendor_order_reject_${seeded.paymentId}_${vo.vendorOrderId}`;
    const trigName = `trg_test_commit_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const fnName = `fn_test_commit_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${fnName}"()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."idempotencyKey" = '${targetIdemKey}' THEN
          RAISE EXCEPTION 'INJECTED_DURING_POSTGRES_COMMIT_FAILURE' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER "${trigName}"
      AFTER INSERT ON "refunds"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION "${fnName}"();
    `);

    try {
      await expect(vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId)).rejects.toThrow();

      const storedVo = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vo.vendorOrderId } });
      expect(storedVo.status).toBe(VendorOrderStatus.PENDING);

      const storedProduct = await prisma.product.findUniqueOrThrow({ where: { id: vo.productId } });
      expect(storedProduct.quantityAvailable).toBe(vo.initialProductQty);

      const events = await prisma.inventoryEvent.findMany({ where: { vendorOrderId: vo.vendorOrderId } });
      expect(events).toHaveLength(0);

      const refunds = await prisma.refund.findMany({ where: { paymentId: seeded.paymentId! } });
      expect(refunds).toHaveLength(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigName}" ON "refunds"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fnName}"()`);
    }
  });

  it('3. WiPay paid order rejection retains durable REQUIRED manual refund obligation & explicit operational status without fabricating confirmation', async () => {
    const seeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '150.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '150.00' },
    });
    const vo = seeded.vendorOrders[0]!;

    const result = await vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId);
    expect(result.status).toBe(VendorOrderStatus.REJECTED);
    expect(result.refundObligation).toBeDefined();
    expect(result.refundObligation?.status).toBe(RefundStatus.REQUIRED);
    expect(result.refundObligation?.amount).toBe('150.00');
    expect(result.refundObligation?.provider).toBe(PaymentProviderName.WIPAY);
    expect(result.refundObligation?.automatedRefundSupported).toBe(false);
    expect(result.refundObligation?.manualRefundRequired).toBe(true);
    expect(result.refundObligation?.operationalStatus).toBe('MANUAL_REFUND_REQUIRED');

    const storedRefund = await prisma.refund.findUniqueOrThrow({
      where: { idempotencyKey: `refund_vendor_order_reject_${seeded.paymentId}_${vo.vendorOrderId}` },
    });
    expect(storedRefund.status).toBe(RefundStatus.REQUIRED);
    expect(storedRefund.providerReference).toBeNull();
    expect(new Prisma.Decimal(storedRefund.amount).toFixed(2)).toBe('150.00');

    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId! } });
    expect(storedPayment.status).toBe(PaymentStatus.PAID);

    const storedProduct = await prisma.product.findUniqueOrThrow({ where: { id: vo.productId } });
    expect(storedProduct.quantityAvailable).toBe(vo.initialProductQty + 2);
  });

  it('4. COD paid order executes refund outside tx (COMPLETED) & post-commit gateway outage transitions durable obligation to RECONCILE_REQUIRED without rolling back rejection', async () => {
    const codSeeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '75.50', quantity: 2 }],
      payment: { provider: PaymentProviderName.CASH_ON_DELIVERY, status: PaymentStatus.PAID, amount: '75.50' },
    });
    const resCod = await vendorOrdersService.reject(vendorUser1Id, codSeeded.vendorOrders[0]!.vendorOrderId);
    expect(resCod.status).toBe(VendorOrderStatus.REJECTED);
    expect(resCod.refundObligation?.status).toBe(RefundStatus.COMPLETED);
    expect(resCod.refundObligation?.operationalStatus).toBe('REFUND_COMPLETED');
    expect(resCod.refundObligation?.manualRefundRequired).toBe(false);

    const paymentAfterCod = await prisma.payment.findUniqueOrThrow({ where: { id: codSeeded.paymentId! } });
    expect(paymentAfterCod.status).toBe(PaymentStatus.REFUNDED);

    // Gateway error outside tx
    const gwFailSeeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '90.00', quantity: 1 }],
      payment: { provider: PaymentProviderName.CASH_ON_DELIVERY, status: PaymentStatus.PAID, amount: '90.00' },
    });
    const spy = jest.spyOn(codAdapter, 'refundPayment').mockRejectedValueOnce(new Error('GATEWAY_TIMEOUT'));
    const resGwFail = await vendorOrdersService.reject(vendorUser1Id, gwFailSeeded.vendorOrders[0]!.vendorOrderId);
    spy.mockRestore();

    expect(resGwFail.status).toBe(VendorOrderStatus.REJECTED);
    expect(resGwFail.refundObligation?.status).toBe(RefundStatus.RECONCILE_REQUIRED);
    expect(resGwFail.refundObligation?.operationalStatus).toBe('REFUND_RECONCILIATION_REQUIRED');
    expect(resGwFail.refundObligation?.manualRefundRequired).toBe(true);

    const reconRefund = await prisma.refund.findUniqueOrThrow({
      where: {
        idempotencyKey: `refund_vendor_order_reject_${gwFailSeeded.paymentId}_${gwFailSeeded.vendorOrders[0]!.vendorOrderId}`,
      },
    });
    expect(reconRefund.status).toBe(RefundStatus.RECONCILE_REQUIRED);
  });

  it('5. Handles unpaid (PENDING/no payment), partially paid, and partially refunded multi-vendor orders accurately', async () => {
    // Unpaid PENDING order -> REJECTED + stock restored, 0 refunds
    const unpaid = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '50.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PENDING, amount: '50.00' },
    });
    const unpaidRes = await vendorOrdersService.reject(vendorUser1Id, unpaid.vendorOrders[0]!.vendorOrderId);
    expect(unpaidRes.status).toBe(VendorOrderStatus.REJECTED);
    expect(unpaidRes.refundObligation).toBeUndefined();
    expect(await prisma.refund.count({ where: { paymentId: unpaid.paymentId! } })).toBe(0);

    // Partially paid / capped balance (Payment 40.00 < VO subtotal 60.00) -> Refund capped at 40.00
    const partialPay = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '60.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '40.00' },
    });
    const partialRes = await vendorOrdersService.reject(vendorUser1Id, partialPay.vendorOrders[0]!.vendorOrderId);
    expect(partialRes.refundObligation?.amount).toBe('40.00');

    // Multi-vendor WIPAY: VO1 (60.00) rejected, then VO2 (40.00) rejected -> 2 durable REQUIRED refunds summing to 100.00
    const multi = await seedOrderWithPayment({
      vendors: [
        { vendorId: vendor1Id, subtotal: '60.00', quantity: 2 },
        { vendorId: vendor2Id, subtotal: '40.00', quantity: 1 },
      ],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '100.00' },
    });
    const vo1 = multi.vendorOrders[0]!;
    const vo2 = multi.vendorOrders[1]!;

    const r1Res = await vendorOrdersService.reject(vendorUser1Id, vo1.vendorOrderId);
    expect(r1Res.refundObligation?.amount).toBe('60.00');

    const storedVo2Mid = await prisma.vendorOrder.findUniqueOrThrow({ where: { id: vo2.vendorOrderId } });
    expect(storedVo2Mid.status).toBe(VendorOrderStatus.PENDING);

    const r2Res = await vendorOrdersService.reject(vendorUser2Id, vo2.vendorOrderId);
    expect(r2Res.refundObligation?.amount).toBe('40.00');

    const allRefunds = await prisma.refund.findMany({ where: { paymentId: multi.paymentId! } });
    expect(allRefunds).toHaveLength(2);
    const totalObligated = allRefunds.reduce(
      (sum, r) => sum.add(new Prisma.Decimal(r.amount)),
      new Prisma.Decimal(0),
    );
    expect(totalObligated.toFixed(2)).toBe('100.00');
  });

  it('6. Blocks sequential & concurrent duplicate rejections with zero duplicate stock restoration or refunds', async () => {
    const seeded = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '95.00', quantity: 3 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '95.00' },
    });
    const vo = seeded.vendorOrders[0]!;

    const race = await Promise.allSettled([
      vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId),
      vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const loserErr = (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    expect(loserErr).toBeInstanceOf(ConflictException);

    // Subsequent sequential retry -> BadRequestException
    await expect(vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const product = await prisma.product.findUniqueOrThrow({ where: { id: vo.productId } });
    expect(product.quantityAvailable).toBe(vo.initialProductQty + 3);
    expect(await prisma.inventoryEvent.count({ where: { vendorOrderId: vo.vendorOrderId } })).toBe(1);
    expect(await prisma.refund.count({ where: { paymentId: seeded.paymentId! } })).toBe(1);
  });

  it('7. Serializes simultaneous vendor reject vs customer cancelOrder/cancelVendorOrder on paid order with 1 stock restore and 1 refund', async () => {
    const seededA = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '80.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '80.00' },
    });
    const voA = seededA.vendorOrders[0]!;

    const raceCancelOrder = await Promise.allSettled([
      vendorOrdersService.reject(vendorUser1Id, voA.vendorOrderId),
      ordersService.cancelOrder(customerUserId, seededA.orderId),
    ]);
    expect(raceCancelOrder.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raceCancelOrder.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.inventoryEvent.count({ where: { vendorOrderId: voA.vendorOrderId } })).toBe(1);
    expect(await prisma.refund.count({ where: { paymentId: seededA.paymentId! } })).toBe(1);
    const prodA = await prisma.product.findUniqueOrThrow({ where: { id: voA.productId } });
    expect(prodA.quantityAvailable).toBe(voA.initialProductQty + 2);

    const seededB = await seedOrderWithPayment({
      vendors: [{ vendorId: vendor1Id, subtotal: '70.00', quantity: 2 }],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '70.00' },
    });
    const voB = seededB.vendorOrders[0]!;

    const raceCancelVo = await Promise.allSettled([
      vendorOrdersService.reject(vendorUser1Id, voB.vendorOrderId),
      ordersService.cancelVendorOrder(customerUserId, seededB.orderId, voB.vendorOrderId),
    ]);
    expect(raceCancelVo.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raceCancelVo.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.inventoryEvent.count({ where: { vendorOrderId: voB.vendorOrderId } })).toBe(1);
    expect(await prisma.refund.count({ where: { paymentId: seededB.paymentId! } })).toBe(1);
  });

  it('8. Catch-weight expired listing disposes inventory cleanly without restocking while still persisting durable Refund obligation', async () => {
    const seeded = await seedOrderWithPayment({
      vendors: [
        {
          vendorId: vendor1Id,
          subtotal: '65.00',
          quantity: 2,
          catchWeight: { expired: true, lotSafety: FoodSafetyStatus.SAFE },
        },
      ],
      payment: { provider: PaymentProviderName.WIPAY, status: PaymentStatus.PAID, amount: '65.00' },
    });
    const vo = seeded.vendorOrders[0]!;

    const result = await vendorOrdersService.reject(vendorUser1Id, vo.vendorOrderId);
    expect(result.status).toBe(VendorOrderStatus.REJECTED);
    expect(result.refundObligation?.status).toBe(RefundStatus.REQUIRED);
    expect(result.refundObligation?.amount).toBe('65.00');

    const listing = await prisma.vendorDailyListing.findUniqueOrThrow({ where: { id: vo.listingId! } });
    expect(new Prisma.Decimal(listing.quantityAvailable).toFixed(2)).toBe('10.00');
    expect(new Prisma.Decimal(listing.quantitySold).toFixed(2)).toBe('0.00');

    const events = await prisma.inventoryEvent.findMany({ where: { vendorOrderId: vo.vendorOrderId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('DISPOSED');
    expect(events[0]!.notes).toContain('EXPIRED_ON_REJECT');

    const refund = await prisma.refund.findUniqueOrThrow({
      where: { idempotencyKey: `refund_vendor_order_reject_${seeded.paymentId}_${vo.vendorOrderId}` },
    });
    expect(refund.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refund.amount).toFixed(2)).toBe('65.00');
  });
});
