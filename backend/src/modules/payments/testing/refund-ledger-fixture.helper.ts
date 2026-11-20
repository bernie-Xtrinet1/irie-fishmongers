import { randomUUID } from 'crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CatalogueLifecycleStatus,
  FoodSafetyStatus,
  ListingLifecycleStatus,
  Order,
  Payment,
  PaymentInitiationStatus,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodStorageType,
  User,
  Vendor,
  VendorOrder,
  VendorOrderStatus,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { OrdersRepository } from '../../orders/repositories/orders.repository';
import { VendorOrdersRepository } from '../../orders/repositories/vendor-orders.repository';
import { OrdersService } from '../../orders/services/orders.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PaymentProviderAdapter } from '../interfaces/payment-provider.interface';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { PaymentSettlementRepository } from '../repositories/payment-settlement.repository';
import { PaymentsRepository } from '../repositories/payments.repository';
import { RefundAttemptsRepository } from '../repositories/refund-attempts.repository';
import { RefundReconciliationRepository } from '../repositories/refund-reconciliation.repository';
import { RefundsRepository } from '../repositories/refunds.repository';
import { PaymentsService } from '../services/payments.service';
import { RefundRecoveryInspectionService } from '../services/refund-recovery-inspection.service';

export interface RefundLedgerHarness {
  prisma: PrismaService;
  ordersRepo: OrdersRepository;
  vendorOrdersRepo: VendorOrdersRepository;
  productsRepo: ProductsRepository;
  vendorsRepo: VendorsRepository;
  inventoryEventsRepo: InventoryEventsRepository;
  paymentsRepo: PaymentsRepository;
  refundsRepo: RefundsRepository;
  attemptsRepo: RefundAttemptsRepository;
  reconciliationRepo: RefundReconciliationRepository;
  inspectionService: RefundRecoveryInspectionService;
  settlementRepo: PaymentSettlementRepository;
  ordersService: OrdersService;
  customerUser: User;
  vendor: Vendor;
  categoryId: string;
  seedOrderWithPayment: (opts?: {
    amount?: string;
    subtotals?: string[];
    provider?: PaymentProviderName;
    paymentStatus?: PaymentStatus;
    initiationStatus?: PaymentInitiationStatus;
    providerReference?: string | null;
  }) => Promise<{ order: Order; vendorOrders: VendorOrder[]; payment: Payment }>;
  createPaymentsService: (
    codAdapter?: Partial<PaymentProviderAdapter>,
    emitter?: EventEmitter2,
    overrideAttemptsRepo?: RefundAttemptsRepository,
  ) => PaymentsService;
  destroy: () => Promise<void>;
}

export async function createRefundLedgerHarness(): Promise<RefundLedgerHarness> {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const ordersRepo = new OrdersRepository(prisma);
  const vendorOrdersRepo = new VendorOrdersRepository(prisma);
  const productsRepo = new ProductsRepository(prisma);
  const vendorsRepo = new VendorsRepository(prisma);
  const inventoryEventsRepo = new InventoryEventsRepository(prisma);
  const paymentsRepo = new PaymentsRepository(prisma);
  const refundsRepo = new RefundsRepository(prisma);
  const attemptsRepo = new RefundAttemptsRepository(prisma);
  const reconciliationRepo = new RefundReconciliationRepository(prisma);
  const inspectionService = new RefundRecoveryInspectionService(reconciliationRepo);
  const settlementRepo = new PaymentSettlementRepository(prisma);

  const mockPaymentsServiceForOrders: any = {
    getByOrderId: jest.fn().mockImplementation(async (orderId: string) => {
      const payment = await prisma.payment.findUnique({ where: { orderId } });
      return payment ?? null;
    }),
    refundForOrder: jest.fn().mockResolvedValue(undefined),
  };

  const ordersService = new OrdersService(
    prisma,
    ordersRepo,
    vendorOrdersRepo,
    {} as any,
    productsRepo,
    vendorsRepo,
    mockPaymentsServiceForOrders,
    {} as any,
    inventoryEventsRepo,
    {} as any,
    new EventEmitter2(),
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  const ts = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const customerRole = await prisma.role.upsert({
    where: { name: RoleName.CUSTOMER },
    update: {},
    create: { name: RoleName.CUSTOMER },
  });
  const vendorRole = await prisma.role.upsert({
    where: { name: RoleName.VENDOR },
    update: {},
    create: { name: RoleName.VENDOR },
  });

  const customerUser = await prisma.user.create({
    data: {
      email: `rl_cust_${ts}@example.com`,
      passwordHash: 'hash',
      firstName: 'Refund',
      lastName: 'Customer',
      phone: '+18765551001',
      roles: { create: { roleId: customerRole.id } },
    },
  });

  const vendorUser = await prisma.user.create({
    data: {
      email: `rl_vend_${ts}@example.com`,
      passwordHash: 'hash',
      firstName: 'Refund',
      lastName: 'Vendor',
      phone: '+18765551002',
      roles: { create: { roleId: vendorRole.id } },
    },
  });

  const vendor = await prisma.vendor.create({
    data: {
      userId: vendorUser.id,
      businessName: `Ledger Fishery ${ts}`,
      parish: 'KINGSTON' as any,
      termsAcceptedAt: new Date(),
      status: 'APPROVED' as any,
    },
  });

  const category = await prisma.category.create({
    data: { name: `Ledger Cat ${ts}`, slug: `ledger-cat-${ts}` },
  });

  const seedOrderWithPayment: RefundLedgerHarness['seedOrderWithPayment'] = async (opts = {}) => {
    const amount = opts.amount ?? '100.00';
    const subtotals = opts.subtotals ?? [amount];
    const order = await prisma.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '10 Harbour St',
        deliveryParish: 'KINGSTON' as any,
        deliveryPhone: '+18765551001',
        currency: 'JMD',
      },
    });

    const vendorOrders: VendorOrder[] = [];
    for (let i = 0; i < subtotals.length; i++) {
      const sub = new Prisma.Decimal(subtotals[i]!);
      const catalogueItem = await prisma.seafoodCatalogueItem.create({
        data: {
          name: `Cat ${randomUUID()}`,
          commonName: 'Snapper',
          categoryId: category.id,
          lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
        },
      });
      const lot = await prisma.seafoodLot.create({
        data: {
          lotNumber: `LOT-${randomUUID()}`,
          vendorId: vendor.id,
          species: 'Snapper',
          storageType: SeafoodStorageType.FRESH,
          catchDate: new Date(),
          weight: new Prisma.Decimal('100.00'),
          weightUnit: WeightUnit.POUNDS,
          foodSafetyStatus: FoodSafetyStatus.SAFE,
        },
      });
      const product = await prisma.product.create({
        data: {
          vendorId: vendor.id,
          categoryId: category.id,
          lotId: lot.id,
          catalogueItemId: catalogueItem.id,
          name: `Snapper ${i + 1}`,
          description: 'Fresh',
          unit: ProductUnit.PER_POUND,
          price: sub,
          quantityAvailable: 50,
          imageUrl: 'https://example.com/snapper.jpg',
        },
      });
      const listing = await prisma.vendorDailyListing.create({
        data: {
          vendorId: vendor.id,
          productId: product.id,
          catalogueItemId: catalogueItem.id,
          lotId: lot.id,
          listingTitle: `Listing ${i + 1}`,
          catchDate: new Date(),
          expiresAt: new Date(Date.now() + 86400_000),
          unit: ProductUnit.PER_POUND,
          price: sub,
          quantityUploaded: new Prisma.Decimal('50.00'),
          quantityAvailable: new Prisma.Decimal('20.00'),
          quantityReserved: new Prisma.Decimal('0.00'),
          quantitySold: new Prisma.Decimal('0.00'),
          status: ListingLifecycleStatus.PUBLISHED,
        },
      });
      const vo = await prisma.vendorOrder.create({
        data: {
          orderId: order.id,
          vendorId: vendor.id,
          subtotal: sub,
          status: VendorOrderStatus.PENDING,
          items: {
            create: [
              {
                productId: product.id,
                productName: product.name,
                unit: product.unit,
                originalListingId: listing.id,
                quantity: 1,
                unitPrice: sub,
                subtotal: sub,
              },
            ],
          },
        },
      });
      vendorOrders.push(vo);
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: opts.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
        status: opts.paymentStatus ?? PaymentStatus.PAID,
        initiationStatus: opts.initiationStatus ?? PaymentInitiationStatus.ESTABLISHED,
        amount: new Prisma.Decimal(amount),
        currency: 'JMD',
        paidAt:
          (opts.paymentStatus ?? PaymentStatus.PAID) === PaymentStatus.PAID ? new Date() : null,
        providerReference:
          opts.providerReference === undefined ? `cod-${order.id}` : opts.providerReference,
      },
    });

    return { order, vendorOrders, payment };
  };

  const createPaymentsService: RefundLedgerHarness['createPaymentsService'] = (
    codAdapter,
    emitter = new EventEmitter2(),
    overrideAttemptsRepo = attemptsRepo,
  ) => {
    const baseAdapter = new CashOnDeliveryAdapter();
    const adapter: PaymentProviderAdapter = {
      name: codAdapter?.name ?? baseAdapter.name,
      createPayment: codAdapter?.createPayment ?? ((input) => baseAdapter.createPayment(input)),
      verifyPayment: codAdapter?.verifyPayment ?? ((ref) => baseAdapter.verifyPayment(ref)),
      refundPayment:
        codAdapter?.refundPayment ??
        ((ref, amt, rsn, ctx) => baseAdapter.refundPayment(ref, amt, rsn, ctx)),
    };
    return new PaymentsService(
      paymentsRepo,
      refundsRepo,
      new WiPayAdapter(null as any),
      adapter as unknown as CashOnDeliveryAdapter,
      emitter,
      overrideAttemptsRepo,
    );
  };

  return {
    prisma,
    ordersRepo,
    vendorOrdersRepo,
    productsRepo,
    vendorsRepo,
    inventoryEventsRepo,
    paymentsRepo,
    refundsRepo,
    attemptsRepo,
    reconciliationRepo,
    inspectionService,
    settlementRepo,
    ordersService,
    customerUser,
    vendor,
    categoryId: category.id,
    seedOrderWithPayment,
    createPaymentsService,
    destroy: async () => {
      await prisma.$disconnect();
    },
  };
}
