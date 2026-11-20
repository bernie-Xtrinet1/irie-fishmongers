import { createHash, randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Order,
  Payment,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  Product,
  ProductUnit,
  Refund,
  RefundStatus,
  Role,
  RoleName,
  SeafoodCatalogueItem,
  SeafoodLot,
  SeafoodStorageType,
  SettlementDisposition,
  SettlementEvidenceProvenance,
  User,
  Vendor,
  VendorDailyListing,
  VendorOrder,
  VendorOrderStatus,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { PaymentSettlementRepository } from '../repositories/payment-settlement.repository';
import { ApplyPaymentSettlementCommand } from '../types/payment-settlement.types';

jest.setTimeout(90_000);

describe('Paid Order Cancellation & Blocker Correction (PostgreSQL Integration Suite)', () => {
  let prisma: PrismaService;
  let ordersRepo: OrdersRepository;
  let vendorOrdersRepo: VendorOrdersRepository;
  let productsRepo: ProductsRepository;
  let vendorsRepo: VendorsRepository;
  let inventoryEventsRepo: InventoryEventsRepository;
  let settlementRepository: PaymentSettlementRepository;
  let ordersService: OrdersService;

  let customerUser: User;
  let otherCustomerUser: User;
  let vendorUser1: User;
  let vendorUser2: User;
  let vendor1: Vendor;
  let vendor2: Vendor;
  let category: CategoryMock;

  interface CategoryMock {
    id: string;
    name: string;
    slug: string;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    ordersRepo = new OrdersRepository(prisma);
    vendorOrdersRepo = new VendorOrdersRepository(prisma);
    productsRepo = new ProductsRepository(prisma);
    vendorsRepo = new VendorsRepository(prisma);
    inventoryEventsRepo = new InventoryEventsRepository(prisma);
    settlementRepository = new PaymentSettlementRepository(prisma);

    const mockPaymentsService: any = {
      getByOrderId: jest.fn().mockImplementation(async (orderId: string) => {
        const payment = await prisma.payment.findUnique({ where: { orderId } });
        if (!payment) return null;
        return {
          id: payment.id,
          orderId: payment.orderId,
          provider: payment.provider,
          status: payment.status,
          initiationStatus: payment.initiationStatus,
          amount: payment.amount.toString(),
          currency: payment.currency,
          paidAt: payment.paidAt,
          createdAt: payment.createdAt,
        };
      }),
      refundOrder: jest.fn().mockResolvedValue(undefined),
      refundForOrder: jest.fn().mockResolvedValue(undefined),
    };

    const mockEventEmitter: any = {
      emitAsync: jest.fn().mockResolvedValue([]),
    };

    ordersService = new OrdersService(
      prisma,
      ordersRepo,
      vendorOrdersRepo,
      {} as any,
      productsRepo,
      vendorsRepo,
      mockPaymentsService,
      {} as any,
      inventoryEventsRepo,
      {} as any,
      mockEventEmitter,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const rolesToEnsure = [RoleName.CUSTOMER, RoleName.VENDOR];
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
    const vendorRole: Role = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.VENDOR },
    });

    customerUser = await prisma.user.create({
      data: {
        email: `poc-cust-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Paula',
        lastName: 'Payer',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    otherCustomerUser = await prisma.user.create({
      data: {
        email: `poc-other-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Oliver',
        lastName: 'Other',
        roles: { create: { roleId: customerRole.id } },
      },
    });

    vendorUser1 = await prisma.user.create({
      data: {
        email: `poc-vend1-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Vince',
        lastName: 'Vendor1',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendorUser2 = await prisma.user.create({
      data: {
        email: `poc-vend2-${randomUUID()}@example.com`,
        passwordHash: 'hashed_pw',
        firstName: 'Val',
        lastName: 'Vendor2',
        roles: { create: { roleId: vendorRole.id } },
      },
    });

    vendor1 = await prisma.vendor.create({
      data: {
        userId: vendorUser1.id,
        businessName: `POC Vendor 1 ${randomUUID().slice(0, 8)}`,
        parish: 'KINGSTON',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    vendor2 = await prisma.vendor.create({
      data: {
        userId: vendorUser2.id,
        businessName: `POC Vendor 2 ${randomUUID().slice(0, 8)}`,
        parish: 'ST_ANDREW',
        termsAcceptedAt: new Date(),
        status: 'APPROVED',
      },
    });

    category = await prisma.category.create({
      data: {
        name: `POC Cat ${randomUUID()}`,
        slug: `poc-cat-${randomUUID()}`,
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
      await prisma.inventoryEvent.deleteMany({});
      await prisma.orderItem.deleteMany({});
      await prisma.vendorOrder.deleteMany({});
      await prisma.order.deleteMany({});
      await prisma.listingPhoto.deleteMany({});
      await prisma.vendorDailyListing.deleteMany({});
      await prisma.product.deleteMany({});
      await prisma.seafoodLot.deleteMany({});
      await prisma.seafoodCatalogueItem.deleteMany({});
      await prisma.category.deleteMany({});
      await prisma.vendor.deleteMany({});
      await prisma.userRole.deleteMany({});
      await prisma.user.deleteMany({});
    } catch {
      // ignore
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  // Helper to create seafood product + listing
  async function createSeafoodFixture(options: {
    vendor: Vendor;
    price: number | Prisma.Decimal | string;
    stock?: number;
    listingAvailable?: number;
    listingSold?: number;
    lotSafety?: FoodSafetyStatus;
    isExpired?: boolean;
  }): Promise<{
    catalogueItem: SeafoodCatalogueItem;
    lot: SeafoodLot;
    product: Product;
    listing: VendorDailyListing;
  }> {
    const price = new Prisma.Decimal(options.price);
    const stock = options.stock ?? 50;
    const listingAvailable = new Prisma.Decimal(options.listingAvailable ?? 20);
    const listingSold = new Prisma.Decimal(options.listingSold ?? 2);
    const lotSafety = options.lotSafety ?? FoodSafetyStatus.SAFE;
    const expiresAt = options.isExpired
      ? new Date(Date.now() - 86400_000)
      : new Date(Date.now() + 86400_000);

    const catalogueItem = await prisma.seafoodCatalogueItem.create({
      data: {
        name: `Seafood ${randomUUID()}`,
        commonName: 'Snapper',
        categoryId: category.id,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      },
    });

    const lot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-${randomUUID()}`,
        vendorId: options.vendor.id,
        species: 'Snapper',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: new Prisma.Decimal('100.00'),
        weightUnit: WeightUnit.POUNDS,
        foodSafetyStatus: lotSafety,
      },
    });

    const product = await prisma.product.create({
      data: {
        vendorId: options.vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name: `Fish ${randomUUID().slice(0, 8)}`,
        description: 'Fresh seafood product',
        unit: ProductUnit.PER_POUND,
        price,
        quantityAvailable: stock,
        imageUrl: 'https://example.com/fish.jpg',
      },
    });

    const listing = await prisma.vendorDailyListing.create({
      data: {
        vendorId: options.vendor.id,
        productId: product.id,
        catalogueItemId: catalogueItem.id,
        lotId: lot.id,
        listingTitle: `Listing ${randomUUID().slice(0, 8)}`,
        catchDate: new Date(),
        expiresAt,
        unit: ProductUnit.PER_POUND,
        price,
        quantityUploaded: new Prisma.Decimal('50.00'),
        quantityAvailable: listingAvailable,
        quantityReserved: new Prisma.Decimal('0.00'),
        quantitySold: listingSold,
        status: ListingLifecycleStatus.PUBLISHED,
      },
    });

    await prisma.listingPhoto.create({
      data: {
        vendorDailyListingId: listing.id,
        url: 'https://example.com/photo.jpg',
        isPrimary: true,
        moderationStatus: ListingPhotoModerationStatus.APPROVED,
      },
    });

    return { catalogueItem, lot, product, listing };
  }

  // Helper to create non-seafood product
  async function createGroceryFixture(options: {
    vendor: Vendor;
    price: number | Prisma.Decimal | string;
    stock?: number;
  }): Promise<{ product: Product }> {
    const price = new Prisma.Decimal(options.price);
    const stock = options.stock ?? 100;

    const product = await prisma.product.create({
      data: {
        vendorId: options.vendor.id,
        categoryId: category.id,
        name: `Grocery ${randomUUID().slice(0, 8)}`,
        description: 'Non-seafood grocery item',
        unit: ProductUnit.PER_POUND,
        price,
        quantityAvailable: stock,
        imageUrl: 'https://example.com/grocery.jpg',
      },
    });

    return { product };
  }

  interface SeedOrderVendorItem {
    product: Product;
    listing?: VendorDailyListing;
    quantity: number;
    unitPrice: number | Prisma.Decimal | string;
    subtotal: number | Prisma.Decimal | string;
  }

  interface SeedOrderVendorGroup {
    vendor: Vendor;
    subtotal: number | Prisma.Decimal | string;
    status?: VendorOrderStatus;
    items: SeedOrderVendorItem[];
  }

  // Master helper to seed test orders with associated payments
  async function seedOrderGraph(options: {
    customer?: User;
    currency?: string;
    vendorGroups: SeedOrderVendorGroup[];
    payment?: {
      status: PaymentStatus;
      initiationStatus?: PaymentInitiationStatus;
      amount: number | Prisma.Decimal | string;
      currency?: string;
      provider?: PaymentProviderName;
      providerReference?: string | null;
      priorRefunds?: Array<{
        amount: number | Prisma.Decimal | string;
        status: RefundStatus;
        idempotencyKey?: string;
      }>;
    };
  }): Promise<{ order: Order; vendorOrders: VendorOrder[]; payment: Payment | null }> {
    const customer = options.customer ?? customerUser;
    const currency = options.currency ?? 'JMD';

    const order = await ordersRepo.create({
      customerId: customer.id,
      deliveryAddressLine1: '123 Harbor View',
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765559876',
      currency,
      vendorOrders: options.vendorGroups.map((vg) => ({
        vendorId: vg.vendor.id,
        subtotal: vg.subtotal,
        items: vg.items.map((it) => ({
          productId: it.product.id,
          productName: it.product.name,
          unitPrice: it.unitPrice,
          unit: it.product.unit,
          quantity: it.quantity,
          subtotal: it.subtotal,
          currency,
          originalListingId: it.listing?.id,
        })),
      })),
    });

    // Update statuses if non-default specified
    for (let i = 0; i < options.vendorGroups.length; i++) {
      const vg = options.vendorGroups[i]!;
      if (vg.status && vg.status !== VendorOrderStatus.PENDING) {
        await prisma.vendorOrder.update({
          where: { id: order.vendorOrders[i]!.id },
          data: { status: vg.status },
        });
      }
    }

    let payment: Payment | null = null;
    if (options.payment) {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: options.payment.provider ?? PaymentProviderName.WIPAY,
          merchantAccountId: 'default',
          status: options.payment.status,
          initiationStatus: options.payment.initiationStatus ?? PaymentInitiationStatus.ESTABLISHED,
          amount: new Prisma.Decimal(options.payment.amount),
          currency: options.payment.currency ?? currency,
          providerReference: options.payment.providerReference ?? `ref_${randomUUID()}`,
          paidAt: options.payment.status === PaymentStatus.PAID ? new Date() : null,
        },
      });

      if (options.payment.priorRefunds) {
        for (const pr of options.payment.priorRefunds) {
          await prisma.refund.create({
            data: {
              paymentId: payment.id,
              amount: new Prisma.Decimal(pr.amount),
              reason: 'Prior refund',
              status: pr.status,
              idempotencyKey: pr.idempotencyKey ?? `prior_ref_${randomUUID()}`,
            },
          });
        }
      }
    }

    const fetchedVendorOrders = await prisma.vendorOrder.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
    });

    return { order, vendorOrders: fetchedVendorOrders, payment };
  }

  // --------------------------------------------------------------------------
  // SCENARIO 1: Complete cancellation of a PAID order creates a single REQUIRED refund
  // --------------------------------------------------------------------------
  it('Scenario 1: Complete cancellation of a PAID order creates a single REQUIRED refund obligation matching full subtotal', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '60.00', stock: 10 });
    const f2 = await createSeafoodFixture({ vendor: vendor2, price: '40.00', stock: 10 });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '60.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '60.00', subtotal: '60.00' }],
        },
        {
          vendor: vendor2,
          subtotal: '40.00',
          items: [{ product: f2.product, listing: f2.listing, quantity: 1, unitPrice: '40.00', subtotal: '40.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '100.00',
      },
    });

    const response = await ordersService.cancelOrder(customerUser.id, order.id);

    // Verify all vendor orders are CANCELLED
    expect(response.vendorOrders).toHaveLength(2);
    expect(response.vendorOrders.every((vo) => vo.status === 'CANCELLED')).toBe(true);

    // Verify refund obligations
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('100.00'))).toBe(true);
    expect(refunds[0]!.idempotencyKey).toBe(`refund_order_cancel_${payment!.id}`);
    expect(refunds[0]!.reason).toBe('Customer order cancellation');

    // Payment status remains PAID (not prematurely transitioned to REFUNDED)
    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } });
    expect(storedPayment.status).toBe(PaymentStatus.PAID);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 2: Partial cancellation of a multi-vendor PAID order creates a REQUIRED refund
  // --------------------------------------------------------------------------
  it('Scenario 2: Partial cancellation of a multi-vendor PAID order creates a REQUIRED refund obligation matching cancelled vendor-order subtotal', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '45.00' });
    const f2 = await createSeafoodFixture({ vendor: vendor2, price: '55.00' });

    const { order, vendorOrders, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '45.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '45.00', subtotal: '45.00' }],
        },
        {
          vendor: vendor2,
          subtotal: '55.00',
          items: [{ product: f2.product, listing: f2.listing, quantity: 1, unitPrice: '55.00', subtotal: '55.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '100.00',
      },
    });

    const targetVendorOrder = vendorOrders.find((vo) => vo.vendorId === vendor1.id)!;
    const remainingVendorOrder = vendorOrders.find((vo) => vo.vendorId === vendor2.id)!;

    const response = await ordersService.cancelVendorOrder(customerUser.id, order.id, targetVendorOrder.id);

    // Target vendor order is cancelled, remaining stays PENDING
    const targetStatus = response.vendorOrders.find((vo) => vo.id === targetVendorOrder.id)?.status;
    const remainingStatus = response.vendorOrders.find((vo) => vo.id === remainingVendorOrder.id)?.status;
    expect(targetStatus).toBe('CANCELLED');
    expect(remainingStatus).toBe('PENDING');

    // Exactly 1 refund obligation for 45.00
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('45.00'))).toBe(true);
    expect(refunds[0]!.idempotencyKey).toBe(`refund_vendor_order_cancel_${payment!.id}_${targetVendorOrder.id}`);

    // Payment status remains PAID
    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } });
    expect(storedPayment.status).toBe(PaymentStatus.PAID);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 3: Cancellation of a PARTIALLY_REFUNDED order creates a REQUIRED refund capped at remaining balance
  // --------------------------------------------------------------------------
  it('Scenario 3: Cancellation of a PARTIALLY_REFUNDED order creates a REQUIRED refund obligation capped at remaining refundable balance', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '100.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '100.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '100.00', subtotal: '100.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amount: '100.00',
        priorRefunds: [
          {
            amount: '35.00',
            status: RefundStatus.COMPLETED,
            idempotencyKey: `prior_completed_${randomUUID()}`,
          },
        ],
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    // All refunds: prior 35.00 + new 65.00 = 100.00
    const refunds = await prisma.refund.findMany({
      where: { paymentId: payment!.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.status).toBe(RefundStatus.COMPLETED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('35.00'))).toBe(true);

    expect(refunds[1]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[1]!.amount).equals(new Prisma.Decimal('65.00'))).toBe(true);
    expect(refunds[1]!.idempotencyKey).toBe(`refund_order_cancel_${payment!.id}`);

    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } });
    expect(storedPayment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 4: Cancellation of a fully REFUNDED order creates NO new refund obligation
  // --------------------------------------------------------------------------
  it('Scenario 4: Cancellation of a fully REFUNDED order creates NO new refund obligation', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '100.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '100.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '100.00', subtotal: '100.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.REFUNDED,
        amount: '100.00',
        priorRefunds: [
          {
            amount: '100.00',
            status: RefundStatus.COMPLETED,
            idempotencyKey: `full_prior_refund_${randomUUID()}`,
          },
        ],
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.COMPLETED);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 5: Cancellation of a PENDING-payment order creates NO refund obligation; stock restored
  // --------------------------------------------------------------------------
  it('Scenario 5: Cancellation of a PENDING-payment order creates NO refund obligation; vendor-orders become CANCELLED and stock restored', async () => {
    const f1 = await createSeafoodFixture({
      vendor: vendor1,
      price: '50.00',
      stock: 10,
      listingAvailable: 10,
      listingSold: 2,
    });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '50.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 2, unitPrice: '25.00', subtotal: '50.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PENDING,
        amount: '50.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    // No refund obligations created
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(0);

    // Stock restored
    const updatedProduct = await prisma.product.findUniqueOrThrow({ where: { id: f1.product.id } });
    expect(updatedProduct.quantityAvailable).toBe(12);

    const updatedListing = await prisma.vendorDailyListing.findUniqueOrThrow({ where: { id: f1.listing.id } });
    expect(new Prisma.Decimal(updatedListing.quantityAvailable).equals(new Prisma.Decimal('12.00'))).toBe(true);
    expect(new Prisma.Decimal(updatedListing.quantitySold).equals(new Prisma.Decimal('0.00'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 6: Cancellation of an ESTABLISHED-initiation order creates NO refund obligation
  // --------------------------------------------------------------------------
  it('Scenario 6: Cancellation of an ESTABLISHED-initiation order creates NO refund obligation', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '75.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '75.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '75.00', subtotal: '75.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PENDING,
        initiationStatus: PaymentInitiationStatus.ESTABLISHED,
        amount: '75.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 7: Cancellation of a RECONCILE_REQUIRED-initiation order creates NO refund obligation
  // --------------------------------------------------------------------------
  it('Scenario 7: Cancellation of a RECONCILE_REQUIRED-initiation order creates NO refund obligation', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '85.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '85.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '85.00', subtotal: '85.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PENDING,
        initiationStatus: PaymentInitiationStatus.RECONCILE_REQUIRED,
        amount: '85.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 8: Cancellation of a FAILED-payment order creates NO refund obligation
  // --------------------------------------------------------------------------
  it('Scenario 8: Cancellation of a FAILED-payment order creates NO refund obligation', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '90.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '90.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '90.00', subtotal: '90.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.FAILED,
        amount: '90.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 9: Cancellation of an order without payment creates NO refund obligation
  // --------------------------------------------------------------------------
  it('Scenario 9: Cancellation of an order without payment creates NO refund obligation', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '30.00' });

    const { order } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '30.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '30.00', subtotal: '30.00' }],
        },
      ],
    });

    const response = await ordersService.cancelOrder(customerUser.id, order.id);
    expect(response.vendorOrders[0]!.status).toBe('CANCELLED');

    const totalRefunds = await prisma.refund.count();
    // No refund records created for this order
    const orderRefunds = await prisma.refund.findMany({ where: { payment: { orderId: order.id } } });
    expect(orderRefunds).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 10: Repeated cancellation calls are idempotent
  // --------------------------------------------------------------------------
  it('Scenario 10: Repeated cancellation calls are idempotent: second call rejects with 400; exactly one refund obligation exists', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '80.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '80.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '80.00', subtotal: '80.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '80.00',
      },
    });

    // First call succeeds
    const firstResult = await ordersService.cancelOrder(customerUser.id, order.id);
    expect(firstResult.vendorOrders[0]!.status).toBe('CANCELLED');

    // Second call rejects with BadRequestException (400)
    await expect(ordersService.cancelOrder(customerUser.id, order.id)).rejects.toBeInstanceOf(BadRequestException);

    // Exactly 1 refund obligation exists
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('80.00'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 11: Concurrent cancellation attempts on the same PAID order result in exactly one set of refund obligations
  // --------------------------------------------------------------------------
  it('Scenario 11: Concurrent cancellation attempts on the same PAID order result in exactly one set of refund obligations without deadlock or duplicate refunds', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '60.00' });
    const f2 = await createSeafoodFixture({ vendor: vendor2, price: '40.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '60.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '60.00', subtotal: '60.00' }],
        },
        {
          vendor: vendor2,
          subtotal: '40.00',
          items: [{ product: f2.product, listing: f2.listing, quantity: 1, unitPrice: '40.00', subtotal: '40.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '100.00',
      },
    });

    const results = await Promise.allSettled([
      ordersService.cancelOrder(customerUser.id, order.id),
      ordersService.cancelOrder(customerUser.id, order.id),
    ]);

    // Exactly one fulfilled, the other rejected (serialized cleanly)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one refund obligation created
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('100.00'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 12: Concurrent cancellation and settlement execution do not deadlock
  // --------------------------------------------------------------------------
  it('Scenario 12: Concurrent cancellation and settlement execution do not deadlock (canonical lock ordering verified)', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '50.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '50.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '50.00', subtotal: '50.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PENDING,
        amount: '50.00',
      },
    });

    const rawPayload = { simulated: true, paymentId: payment!.id };
    const payloadStr = JSON.stringify(rawPayload);
    const evidenceDigest = createHash('sha256').update(payloadStr, 'utf8').digest('hex');

    const settlementCommand: ApplyPaymentSettlementCommand = {
      orderId: order.id,
      paymentId: payment!.id,
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: 'default',
      eventId: `sim_evt_${randomUUID()}`,
      gatewayTxnId: payment!.providerReference ?? `sim_gw_${randomUUID()}`,
      amount: new Prisma.Decimal('50.00'),
      currency: 'JMD',
      outcome: PaymentStatus.PAID,
      evidence: {
        sourceIp: '127.0.0.1',
        rawPayload,
        evidenceDigest,
        provenance: SettlementEvidenceProvenance.TRUSTED_TEST_SIMULATOR,
        signatureValid: true,
        eventTimestamp: new Date(),
      },
    };

    // Concurrently execute cancellation and settlement
    const results = await Promise.allSettled([
      ordersService.cancelOrder(customerUser.id, order.id),
      settlementRepository.executeSettlementTransaction(settlementCommand),
    ]);

    // Neither threw an unhandled deadlock error
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Vendor orders are CANCELLED
    const storedVendorOrders = await prisma.vendorOrder.findMany({ where: { orderId: order.id } });
    expect(storedVendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED)).toBe(true);

    // Payment is PAID
    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } });
    expect(storedPayment.status).toBe(PaymentStatus.PAID);

    // A REQUIRED refund obligation exists (either post_cancel or order_cancel)
    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds.length).toBeGreaterThanOrEqual(1);
    expect(refunds.every((r) => r.status === RefundStatus.REQUIRED)).toBe(true);
    const totalRefunded = refunds.reduce((sum, r) => sum.add(r.amount), new Prisma.Decimal(0));
    expect(totalRefunded.equals(new Prisma.Decimal('50.00'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 13: Inventory restock behavior on cancellation: active vs expired/unsafe
  // --------------------------------------------------------------------------
  it('Scenario 13: Inventory restock behavior on cancellation: active listings increment quantityAvailable; expired listings record DISPOSED inventory events', async () => {
    // Active & safe listing
    const activeFixture = await createSeafoodFixture({
      vendor: vendor1,
      price: '40.00',
      stock: 10,
      listingAvailable: 10,
      listingSold: 2,
      isExpired: false,
      lotSafety: FoodSafetyStatus.SAFE,
    });

    // Expired listing
    const expiredFixture = await createSeafoodFixture({
      vendor: vendor2,
      price: '30.00',
      stock: 10,
      listingAvailable: 10,
      listingSold: 2,
      isExpired: true,
      lotSafety: FoodSafetyStatus.SAFE,
    });

    const { order } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '40.00',
          items: [{ product: activeFixture.product, listing: activeFixture.listing, quantity: 2, unitPrice: '20.00', subtotal: '40.00' }],
        },
        {
          vendor: vendor2,
          subtotal: '30.00',
          items: [{ product: expiredFixture.product, listing: expiredFixture.listing, quantity: 2, unitPrice: '15.00', subtotal: '30.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '70.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    // 1. Active listing was RESTOCKED: available incremented from 10 to 12, sold decremented from 2 to 0
    const updatedActiveListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: activeFixture.listing.id },
    });
    expect(new Prisma.Decimal(updatedActiveListing.quantityAvailable).equals(new Prisma.Decimal('12.00'))).toBe(true);
    expect(new Prisma.Decimal(updatedActiveListing.quantitySold).equals(new Prisma.Decimal('0.00'))).toBe(true);

    // 2. Expired listing was DISPOSED: available NOT incremented (remains 10), sold decremented from 2 to 0
    const updatedExpiredListing = await prisma.vendorDailyListing.findUniqueOrThrow({
      where: { id: expiredFixture.listing.id },
    });
    expect(new Prisma.Decimal(updatedExpiredListing.quantityAvailable).equals(new Prisma.Decimal('10.00'))).toBe(true);
    expect(new Prisma.Decimal(updatedExpiredListing.quantitySold).equals(new Prisma.Decimal('0.00'))).toBe(true);

    // 3. Inventory event for expired listing records DISPOSED with EXPIRED_ON_CANCEL
    const disposedEvent = await prisma.inventoryEvent.findFirst({
      where: {
        productId: expiredFixture.product.id,
        eventType: 'DISPOSED',
      },
    });
    expect(disposedEvent).not.toBeNull();
    const notes = JSON.parse(disposedEvent!.notes!);
    expect(notes.disposition).toBe('EXPIRED_ON_CANCEL');
  });

  // --------------------------------------------------------------------------
  // SCENARIO 14: Payment status after cancellation of a PAID order remains PAID
  // --------------------------------------------------------------------------
  it('Scenario 14: Payment status after cancellation of a PAID order remains PAID (not prematurely transitioned to REFUNDED)', async () => {
    const f1 = await createSeafoodFixture({ vendor: vendor1, price: '120.00' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '120.00',
          items: [{ product: f1.product, listing: f1.listing, quantity: 1, unitPrice: '120.00', subtotal: '120.00' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '120.00',
      },
    });

    await ordersService.cancelOrder(customerUser.id, order.id);

    // Check payment row in database
    const storedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } });
    expect(storedPayment.status).toBe(PaymentStatus.PAID);
    expect(storedPayment.status).not.toBe(PaymentStatus.REFUNDED);

    // REQUIRED refund obligation is present
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { idempotencyKey: `refund_order_cancel_${payment!.id}` },
    });
    expect(refund.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refund.amount).equals(new Prisma.Decimal('120.00'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SCENARIO 15: Multi-vendor order with mixed item types cancels cleanly with exact decimal refund
  // --------------------------------------------------------------------------
  it('Scenario 15: Multi-vendor order with mixed item types (seafood + non-seafood) cancels cleanly with exact decimal refund calculation', async () => {
    const seafood = await createSeafoodFixture({ vendor: vendor1, price: '45.50' });
    const grocery = await createGroceryFixture({ vendor: vendor2, price: '32.25' });

    const { order, payment } = await seedOrderGraph({
      vendorGroups: [
        {
          vendor: vendor1,
          subtotal: '45.50',
          items: [{ product: seafood.product, listing: seafood.listing, quantity: 1, unitPrice: '45.50', subtotal: '45.50' }],
        },
        {
          vendor: vendor2,
          subtotal: '32.25',
          items: [{ product: grocery.product, quantity: 1, unitPrice: '32.25', subtotal: '32.25' }],
        },
      ],
      payment: {
        status: PaymentStatus.PAID,
        amount: '77.75',
      },
    });

    const response = await ordersService.cancelOrder(customerUser.id, order.id);
    expect(response.vendorOrders).toHaveLength(2);
    expect(response.vendorOrders.every((vo) => vo.status === 'CANCELLED')).toBe(true);

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment!.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.REQUIRED);
    expect(new Prisma.Decimal(refunds[0]!.amount).equals(new Prisma.Decimal('77.75'))).toBe(true);
    expect(refunds[0]!.idempotencyKey).toBe(`refund_order_cancel_${payment!.id}`);
  });
});
