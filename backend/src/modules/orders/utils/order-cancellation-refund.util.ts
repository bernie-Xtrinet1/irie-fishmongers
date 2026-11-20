import { randomUUID } from 'crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  OrderItem,
  PaymentProviderName,
  PaymentStatus,
  Prisma,
  Refund,
  RefundObligation,
  RefundObligationStatus,
  RefundStatus,
  VendorOrder,
  VendorOrderStatus,
} from '@prisma/client';

import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import {
  computeRemainingRefundCapacityTx,
  deriveObligationType,
  lockPaymentObligationsAndRefunds,
} from '../../payments/repositories/refund-locks.helper';
import { ACTIVE_REFUND_STATUSES } from '../../payments/repositories/refunds.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorOrdersRepository } from '../repositories/vendor-orders.repository';

export interface LockedPaymentRow {
  id: string;
  orderId: string;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  provider: PaymentProviderName;
  currency: string;
}

export interface LockedVendorOrderRow {
  id: string;
  status: VendorOrderStatus;
  subtotal: Prisma.Decimal;
}

export interface RefundObligationRecord {
  refund: Refund;
  obligation?: RefundObligation;
  created: boolean;
  paymentProvider: PaymentProviderName;
  paymentCurrency: string;
}

/**
 * Acquires PostgreSQL FOR UPDATE locks in the canonical financial hierarchy:
 * Order -> VendorOrders (ascending id) -> Payment.
 */
export async function lockOrderFinancialHierarchy(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{
  vendorOrders: LockedVendorOrderRow[];
  payment: LockedPaymentRow | null;
} | null> {
  if (typeof (tx as any).$queryRaw !== 'function') {
    return null;
  }

  const orderRows = (await (tx as any).$queryRaw(
    Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`,
  )) as Array<{ id: string }>;
  if (orderRows.length === 0) {
    throw new NotFoundException(`Order "${orderId}" not found`);
  }

  const vendorOrders = (await (tx as any).$queryRaw(
    Prisma.sql`SELECT "id", "status", "subtotal" FROM "vendor_orders" WHERE "orderId" = ${orderId} ORDER BY "id" ASC FOR UPDATE`,
  )) as LockedVendorOrderRow[];

  const paymentRows = (await (tx as any).$queryRaw(
    Prisma.sql`SELECT "id", "orderId", "status", "amount", "provider", "currency" FROM "payments" WHERE "orderId" = ${orderId} FOR UPDATE`,
  )) as LockedPaymentRow[];

  return {
    vendorOrders,
    payment: paymentRows[0] ?? null,
  };
}

/**
 * Transitions a PENDING VendorOrder to CANCELLED or REJECTED, acquires canonical
 * product & listing locks, and restores eligible inventory or records DISPOSED events.
 */
export async function restoreVendorOrderStockAndTransition(params: {
  vendorOrder: VendorOrder & { items: OrderItem[] };
  targetStatus: 'CANCELLED' | 'REJECTED';
  dispositionLabel: 'EXPIRED_ON_CANCEL' | 'EXPIRED_ON_REJECT';
  tx: Prisma.TransactionClient;
  productsRepository: ProductsRepository;
  inventoryEventsRepository: InventoryEventsRepository;
  vendorOrdersRepository: VendorOrdersRepository;
}): Promise<ReturnType<VendorOrdersRepository['updateStatus']>> {
  const {
    vendorOrder,
    targetStatus,
    dispositionLabel,
    tx,
    productsRepository,
    inventoryEventsRepository,
    vendorOrdersRepository,
  } = params;

  if ((tx as any).vendorOrder?.updateMany) {
    const updateResult = await (tx as any).vendorOrder.updateMany({
      where: { id: vendorOrder.id, status: 'PENDING' },
      data: { status: targetStatus },
    });
    if (updateResult.count === 0) {
      throw new ConflictException(
        `Vendor order "${vendorOrder.id}" is not in PENDING status or was concurrently modified.`,
      );
    }
  }

  if ((tx as any).$queryRaw) {
    const sortedProductIds = Array.from(
      new Set(vendorOrder.items.map((item) => item.productId)),
    ).sort();
    for (const productId of sortedProductIds) {
      await (tx as any).$queryRaw(
        Prisma.sql`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`,
      );
    }

    const sortedListingIds = Array.from(
      new Set(
        vendorOrder.items
          .map((item) => item.originalListingId)
          .filter((listingId): listingId is string => Boolean(listingId)),
      ),
    ).sort();
    for (const listingId of sortedListingIds) {
      await (tx as any).$queryRaw(
        Prisma.sql`SELECT id FROM vendor_daily_listings WHERE id = ${listingId} FOR UPDATE`,
      );
    }
  }

  const now = new Date();
  for (const item of vendorOrder.items) {
    if (item.originalListingId && (tx as any).vendorDailyListing) {
      const listing = await (tx as any).vendorDailyListing.findUnique({
        where: { id: item.originalListingId },
        include: { lot: true },
      });

      const isExpired = listing ? new Date(listing.expiresAt).getTime() <= now.getTime() : true;
      const isSafe = listing?.lot ? listing.lot.foodSafetyStatus === 'SAFE' : true;
      const isPublished = listing?.status === 'PUBLISHED';

      if (listing && !isExpired && isSafe && isPublished) {
        if ((tx as any).$executeRaw) {
          await (tx as any).$executeRaw`
            UPDATE vendor_daily_listings
            SET "quantitySold" = "quantitySold" - ${item.quantity}::decimal,
                "quantityAvailable" = "quantityAvailable" + ${item.quantity}::decimal
            WHERE id = ${item.originalListingId} AND "quantitySold" >= ${item.quantity}::decimal
          `;
        }
        await productsRepository.adjustStock(item.productId, item.quantity, tx);
        await inventoryEventsRepository.create(
          {
            productId: item.productId,
            eventType: 'RESTOCKED',
            quantityDelta: item.quantity,
            vendorOrderId: vendorOrder.id,
          },
          tx,
        );
      } else {
        if ((tx as any).$executeRaw) {
          await (tx as any).$executeRaw`
            UPDATE vendor_daily_listings
            SET "quantitySold" = "quantitySold" - ${item.quantity}::decimal
            WHERE id = ${item.originalListingId} AND "quantitySold" >= ${item.quantity}::decimal
          `;
        }
        await inventoryEventsRepository.create(
          {
            productId: item.productId,
            eventType: 'DISPOSED',
            quantityDelta: -item.quantity,
            vendorOrderId: vendorOrder.id,
            notes: JSON.stringify({
              disposition: dispositionLabel,
              listingId: item.originalListingId,
              orderItemId: item.id,
              quantityDisposed: item.quantity,
            }),
          },
          tx,
        );
      }
    } else {
      await productsRepository.adjustStock(item.productId, item.quantity, tx);
      await inventoryEventsRepository.create(
        {
          productId: item.productId,
          eventType: 'RESTOCKED',
          quantityDelta: item.quantity,
          vendorOrderId: vendorOrder.id,
        },
        tx,
      );
    }
  }

  return vendorOrdersRepository.updateStatus(vendorOrder.id, targetStatus, tx);
}

/**
 * Creates or preserves a durable OPEN RefundObligation and linked REQUIRED Refund
 * inside an active DB transaction under canonical Order -> VendorOrder -> Payment -> Obligation -> Refund locking.
 */
export async function createOrPreserveRefundObligation(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    orderId?: string;
    status: PaymentStatus;
    amount: Prisma.Decimal | number | string;
    provider?: PaymentProviderName;
    currency?: string;
  },
  targetVendorOrders: Array<{ id?: string; subtotal: Prisma.Decimal | number | string }>,
  idempotencyKey: string,
  reason: string,
): Promise<RefundObligationRecord | null> {
  if (!(tx as any).refund) {
    return null;
  }

  await lockPaymentObligationsAndRefunds(tx, payment.id);

  const hasObligationModel = Boolean((tx as any).refundObligation?.findUnique);
  const existingRefund = (await (tx as any).refund.findUnique({
    where: { idempotencyKey },
  })) as Refund | null;

  let existingObligation: RefundObligation | null = null;
  if (hasObligationModel) {
    existingObligation = existingRefund?.obligationId
      ? ((await (tx as any).refundObligation.findUnique({
          where: { id: existingRefund.obligationId },
        })) as RefundObligation | null)
      : ((await (tx as any).refundObligation.findUnique({
          where: { obligationKey: idempotencyKey },
        })) as RefundObligation | null);
  }

  if (existingRefund) {
    if (existingRefund.paymentId !== payment.id) {
      throw new ConflictException(
        `Idempotency key "${idempotencyKey}" belongs to a different payment`,
      );
    }
    return {
      refund: existingRefund,
      obligation: existingObligation ?? undefined,
      created: false,
      paymentProvider: payment.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
      paymentCurrency: payment.currency ?? 'JMD',
    };
  }

  if (existingObligation) {
    if (existingObligation.paymentId !== payment.id) {
      throw new ConflictException(
        `Obligation key "${idempotencyKey}" belongs to a different payment`,
      );
    }
    const latestRefund = (await (tx as any).refund.findFirst({
      where: { obligationId: existingObligation.id },
      orderBy: { createdAt: 'desc' },
    })) as Refund | null;
    if (latestRefund) {
      return {
        refund: latestRefund,
        obligation: existingObligation,
        created: false,
        paymentProvider: payment.provider ?? PaymentProviderName.CASH_ON_DELIVERY,
        paymentCurrency: payment.currency ?? 'JMD',
      };
    }
  }

  const requestedSubtotal = targetVendorOrders.reduce(
    (sum, vo) => sum.add(new Prisma.Decimal(vo.subtotal)),
    new Prisma.Decimal(0),
  );

  let remainingBalance: Prisma.Decimal;
  if (hasObligationModel) {
    const cap = await computeRemainingRefundCapacityTx(tx, payment.id, payment.amount);
    remainingBalance = cap.remainingBalance;
  } else {
    const activeRefunds = await (tx as any).refund.findMany({
      where: { paymentId: payment.id, status: { in: ACTIVE_REFUND_STATUSES } },
    });
    const totalActive = activeRefunds.reduce(
      (sum: Prisma.Decimal, r: { amount: Prisma.Decimal | number | string }) =>
        sum.add(new Prisma.Decimal(r.amount)),
      new Prisma.Decimal(0),
    );
    remainingBalance = new Prisma.Decimal(payment.amount).sub(totalActive);
  }

  if (remainingBalance.lte(0)) {
    return null;
  }

  const obligationAmount = requestedSubtotal.lt(remainingBalance)
    ? requestedSubtotal
    : remainingBalance;
  if (obligationAmount.lte(0)) {
    return null;
  }

  let resolvedOrderId = payment.orderId;
  let resolvedProvider = payment.provider;
  let resolvedCurrency = payment.currency;
  if (!resolvedOrderId && (tx as any).payment?.findUnique) {
    const meta = (await (tx as any).payment.findUnique({
      where: { id: payment.id },
      select: { orderId: true, provider: true, currency: true },
    })) as { orderId: string; provider: PaymentProviderName; currency: string } | null;
    resolvedOrderId = meta?.orderId;
    resolvedProvider = resolvedProvider ?? meta?.provider;
    resolvedCurrency = resolvedCurrency ?? meta?.currency;
  }

  let createdObligation: RefundObligation | undefined;
  if (hasObligationModel && resolvedOrderId) {
    const singleVendorOrderId =
      targetVendorOrders.length === 1 && targetVendorOrders[0]?.id
        ? targetVendorOrders[0].id
        : null;
    createdObligation = (await (tx as any).refundObligation.create({
      data: {
        id: randomUUID(),
        paymentId: payment.id,
        orderId: resolvedOrderId,
        vendorOrderId: singleVendorOrderId,
        obligationKey: idempotencyKey,
        obligationType: deriveObligationType(idempotencyKey),
        authorizedAmount: obligationAmount,
        currency: resolvedCurrency ?? 'JMD',
        reason,
        status: RefundObligationStatus.OPEN,
      },
    })) as RefundObligation;
  }

  const createdRefund = (await (tx as any).refund.create({
    data: {
      idempotencyKey,
      paymentId: payment.id,
      ...(createdObligation ? { obligationId: createdObligation.id } : {}),
      amount: obligationAmount,
      reason,
      status: RefundStatus.REQUIRED,
      providerReference: null,
    },
  })) as Refund;

  return {
    refund: createdRefund,
    obligation: createdObligation,
    created: true,
    paymentProvider: resolvedProvider ?? PaymentProviderName.CASH_ON_DELIVERY,
    paymentCurrency: resolvedCurrency ?? 'JMD',
  };
}
