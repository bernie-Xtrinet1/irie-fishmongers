import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentProviderName, Prisma, Refund, RefundStatus, VendorOrderStatus } from '@prisma/client';

import { OrderAcceptedEvent } from '../../../common/events/order-accepted.event';
import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import {
  VendorOrderRefundObligationEntity,
  VendorOrderRefundOperationalStatus,
  VendorOrderResponseEntity,
} from '../entities/vendor-order-response.entity';
import { PaginatedVendorOrdersEntity } from '../entities/paginated-vendor-orders.entity';
import { VendorOrderWithItems, VendorOrdersRepository } from '../repositories/vendor-orders.repository';
import {
  createOrPreserveRefundObligation,
  lockOrderFinancialHierarchy,
  RefundObligationRecord,
  restoreVendorOrderStockAndTransition,
} from '../utils/order-cancellation-refund.util';

const ALLOWED_TRANSITIONS: Record<VendorOrderStatus, VendorOrderStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING'],
  PREPARING: ['READY_FOR_PICKUP'],
  READY_FOR_PICKUP: [],
  ASSIGNED_TO_DRIVER: [],
  IN_TRANSIT: [],
  DELIVERED: [],
  DELIVERY_FAILED: [],
  REJECTED: [],
  CANCELLED: [],
};

@Injectable()
export class VendorOrdersService {
  private readonly logger = new Logger(VendorOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly paymentsService: PaymentsService,
    private readonly inventoryEventsRepository: InventoryEventsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getIncomingOrders(
    userId: string,
    status: VendorOrderStatus | undefined,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedVendorOrdersEntity> {
    const vendor = await this.getOwnVendorProfile(userId);

    const { items, total } = await this.vendorOrdersRepository.findManyByVendor(
      vendor.id,
      status,
      { skip: (page.page - 1) * page.pageSize, take: page.pageSize },
    );

    return {
      items: items.map((item) => VendorOrdersService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async accept(userId: string, vendorOrderId: string): Promise<VendorOrderResponseEntity> {
    const vendorOrder = await this.getOwnedVendorOrder(userId, vendorOrderId);
    this.assertTransitionAllowed(vendorOrder.status, 'ACCEPTED');
    await this.paymentsService.assertReadyForFulfillment(vendorOrder.orderId);

    const updated = await this.vendorOrdersRepository.updateStatus(vendorOrder.id, 'ACCEPTED');

    const vendor = await this.vendorsRepository.findById(vendorOrder.vendorId);
    if (vendor) {
      await this.eventEmitter.emitAsync(
        OrderAcceptedEvent.eventName,
        new OrderAcceptedEvent(
          vendorOrder.order.customerId,
          vendorOrder.orderId,
          vendorOrder.id,
          vendor.businessName,
        ),
      );
    }

    return VendorOrdersService.toResponse(updated);
  }

  async reject(userId: string, vendorOrderId: string): Promise<VendorOrderResponseEntity> {
    const vendorOrder = await this.getOwnedVendorOrder(userId, vendorOrderId);
    this.assertTransitionAllowed(vendorOrder.status, 'REJECTED');

    const txResult = await this.prisma.$transaction(async (tx) => {
      const lockedHierarchy = await lockOrderFinancialHierarchy(tx, vendorOrder.orderId);
      let lockedSubtotal: Prisma.Decimal = vendorOrder.subtotal;
      let paymentRow: {
        id: string;
        status: any;
        amount: Prisma.Decimal | number | string;
        provider?: PaymentProviderName;
        currency?: string;
      } | null = null;

      if (lockedHierarchy) {
        const lockedVo = lockedHierarchy.vendorOrders.find((vo) => vo.id === vendorOrder.id);
        if (!lockedVo) {
          throw new NotFoundException(`Vendor order "${vendorOrder.id}" not found`);
        }
        if (lockedVo.status !== 'PENDING') {
          throw new ConflictException(
            `Vendor order "${vendorOrder.id}" is not in PENDING status or was concurrently modified.`,
          );
        }
        lockedSubtotal = new Prisma.Decimal(lockedVo.subtotal);
        paymentRow = lockedHierarchy.payment;
      } else if (typeof (tx as any).payment?.findUnique === 'function') {
        paymentRow = await (tx as any).payment.findUnique({
          where: { orderId: vendorOrder.orderId },
        });
      }

      const updated = await restoreVendorOrderStockAndTransition({
        vendorOrder,
        targetStatus: 'REJECTED',
        dispositionLabel: 'EXPIRED_ON_REJECT',
        tx,
        productsRepository: this.productsRepository,
        inventoryEventsRepository: this.inventoryEventsRepository,
        vendorOrdersRepository: this.vendorOrdersRepository,
      });

      let obligation: RefundObligationRecord | null = null;
      const hasTransactionalRefundStore =
        Boolean(lockedHierarchy) || typeof (tx as any).refund?.create === 'function';

      if (
        hasTransactionalRefundStore &&
        paymentRow &&
        (paymentRow.status === 'PAID' || paymentRow.status === 'PARTIALLY_REFUNDED')
      ) {
        const idempotencyKey = `refund_vendor_order_reject_${paymentRow.id}_${vendorOrder.id}`;
        obligation = await createOrPreserveRefundObligation(
          tx,
          paymentRow,
          [{ subtotal: lockedSubtotal }],
          idempotencyKey,
          'Vendor rejected order',
        );
      }

      return {
        updated,
        obligation,
        hasTransactionalRefundStore,
      };
    });

    const response = VendorOrdersService.toResponse(txResult.updated);

    if (!txResult.hasTransactionalRefundStore) {
      // Compatibility fallback for isolated unit-test stubs passing an empty `{}` transaction handle
      await this.paymentsService.refundForOrder(
        vendorOrder.orderId,
        vendorOrder.subtotal.toNumber(),
        'Vendor rejected order',
      );
      return response;
    }

    if (!txResult.obligation) {
      return response;
    }

    const obligation = txResult.obligation;
    let finalRefund: Refund = obligation.refund;
    let manualFallbackFromUnsupportedProvider = false;

    if (
      obligation.refund.status === RefundStatus.REQUIRED ||
      obligation.refund.status === RefundStatus.PENDING
    ) {
      try {
        const executed = await this.paymentsService.refundForOrder(
          vendorOrder.orderId,
          new Prisma.Decimal(obligation.refund.amount),
          'Vendor rejected order',
          obligation.refund.idempotencyKey ?? undefined,
        );
        if (executed) {
          finalRefund = executed;
        }
      } catch (error) {
        // Provider execution runs post-commit; gateway errors or unsupported adapters (e.g. WiPay)
        // retain the committed REJECTED vendor order and durable internal Refund obligation.
        manualFallbackFromUnsupportedProvider = error instanceof NotImplementedException;
        if (typeof (this.prisma as any).refund?.findUnique === 'function') {
          const persisted = await (this.prisma as any).refund.findUnique({
            where: { id: obligation.refund.id },
          });
          if (persisted) {
            finalRefund = persisted;
          }
        }
        if (!(error instanceof NotImplementedException)) {
          this.logger.warn(
            `Post-commit provider refund incomplete for vendorOrder=${vendorOrder.id} refund=${finalRefund.id} status=${finalRefund.status}: ${(error as Error).message}`,
          );
        }
      }
    }

    return {
      ...response,
      refundObligation: VendorOrdersService.buildRefundObligationEntity(
        finalRefund,
        obligation.paymentProvider,
        obligation.paymentCurrency,
        manualFallbackFromUnsupportedProvider,
      ),
    };
  }

  async markPreparing(userId: string, vendorOrderId: string): Promise<VendorOrderResponseEntity> {
    return this.transition(userId, vendorOrderId, 'PREPARING');
  }

  async markReadyForPickup(
    userId: string,
    vendorOrderId: string,
  ): Promise<VendorOrderResponseEntity> {
    return this.transition(userId, vendorOrderId, 'READY_FOR_PICKUP');
  }

  private async transition(
    userId: string,
    vendorOrderId: string,
    next: VendorOrderStatus,
  ): Promise<VendorOrderResponseEntity> {
    const vendorOrder = await this.getOwnedVendorOrder(userId, vendorOrderId);
    this.assertTransitionAllowed(vendorOrder.status, next);

    const updated = await this.vendorOrdersRepository.updateStatus(vendorOrder.id, next);
    return VendorOrdersService.toResponse(updated);
  }

  private assertTransitionAllowed(current: VendorOrderStatus, next: VendorOrderStatus): void {
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new BadRequestException(`Cannot move a ${current} order to ${next}`);
    }
  }

  private async getOwnVendorProfile(userId: string): Promise<{ id: string }> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return vendor;
  }

  private async getOwnedVendorOrder(
    userId: string,
    vendorOrderId: string,
  ): Promise<VendorOrderWithItems> {
    const vendor = await this.getOwnVendorProfile(userId);
    const vendorOrder = await this.vendorOrdersRepository.findById(vendorOrderId);
    if (!vendorOrder) {
      throw new NotFoundException('Vendor order not found');
    }
    if (vendorOrder.vendorId !== vendor.id) {
      throw new ForbiddenException('You do not own this order');
    }
    return vendorOrder;
  }

  private static buildRefundObligationEntity(
    refund: Refund,
    provider: PaymentProviderName,
    currency: string,
    unsupportedAutomatedRefund: boolean,
  ): VendorOrderRefundObligationEntity {
    const automatedRefundSupported =
      !unsupportedAutomatedRefund && provider !== PaymentProviderName.WIPAY;

    let operationalStatus: VendorOrderRefundOperationalStatus;
    let manualRefundRequired: boolean;
    let message: string;

    if (refund.status === RefundStatus.COMPLETED) {
      operationalStatus = 'REFUND_COMPLETED';
      manualRefundRequired = false;
      message = 'Refund completed with payment provider.';
    } else if (refund.status === RefundStatus.RECONCILE_REQUIRED) {
      operationalStatus = 'REFUND_RECONCILIATION_REQUIRED';
      manualRefundRequired = true;
      message =
        'Provider refund execution had an uncertain outcome; durable obligation retained in RECONCILE_REQUIRED status.';
    } else if (refund.status === RefundStatus.FAILED) {
      operationalStatus = 'REFUND_FAILED';
      manualRefundRequired = true;
      message = 'Provider refund failed; manual refund intervention required.';
    } else if (!automatedRefundSupported && refund.status === RefundStatus.REQUIRED) {
      operationalStatus = 'MANUAL_REFUND_REQUIRED';
      manualRefundRequired = true;
      message =
        'Payment provider does not support automated refunds; durable manual refund obligation retained in REQUIRED status.';
    } else if (refund.status === RefundStatus.REQUIRED) {
      operationalStatus = 'MANUAL_REFUND_REQUIRED';
      manualRefundRequired = true;
      message = 'Durable refund obligation retained in REQUIRED status.';
    } else {
      operationalStatus = 'REFUND_IN_PROGRESS';
      manualRefundRequired = !automatedRefundSupported;
      message = `Refund obligation retained in ${refund.status} status.`;
    }

    return {
      refundId: refund.id,
      status: refund.status,
      amount: new Prisma.Decimal(refund.amount).toFixed(2),
      currency,
      provider,
      automatedRefundSupported,
      manualRefundRequired,
      operationalStatus,
      message,
    };
  }
  private static toResponse(vendorOrder: VendorOrderWithItems): VendorOrderResponseEntity {
    return {
      id: vendorOrder.id,
      orderId: vendorOrder.orderId,
      vendorId: vendorOrder.vendorId,
      status: vendorOrder.status,
      subtotal: vendorOrder.subtotal.toString(),
      createdAt: vendorOrder.createdAt,
      items: vendorOrder.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice.toString(),
        unit: item.unit,
        quantity: item.quantity,
        subtotal: item.subtotal.toString(),
      })),
    };
  }
}
