import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderItem, Prisma, VendorOrder } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutDto } from '../dto/checkout.dto';
import { OrderResponseEntity } from '../entities/order-response.entity';
import { PaginatedOrdersEntity } from '../entities/paginated-orders.entity';
import {
  OrdersRepository,
  OrderWithDetails,
  VendorOrderInput,
} from '../repositories/orders.repository';
import { VendorOrdersRepository } from '../repositories/vendor-orders.repository';

const CANCELLABLE_STATUS = 'PENDING';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersRepository: OrdersRepository,
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly paymentsService: PaymentsService,
    private readonly vendorPermissionsService: VendorPermissionsService,
    private readonly inventoryEventsRepository: InventoryEventsRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async checkout(userId: string, dto: CheckoutDto): Promise<OrderResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    if (cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const additionalAmountByVendorId = new Map<string, number>();

    for (const item of cart.items) {
      if (!item.product.isActive) {
        throw new BadRequestException(`"${item.product.name}" is no longer available`);
      }
      if (item.product.lot && item.product.lot.foodSafetyStatus !== 'SAFE') {
        throw new BadRequestException(
          `"${item.product.name}" is currently on hold pending a food-safety review`,
        );
      }
      const vendor = await this.vendorsRepository.findById(item.product.vendorId);
      if (!vendor || vendor.status !== 'APPROVED') {
        throw new BadRequestException(
          `"${item.product.name}" is not currently sold by an approved vendor`,
        );
      }

      const itemSubtotal = item.product.price.times(item.quantity).toNumber();
      additionalAmountByVendorId.set(
        vendor.id,
        (additionalAmountByVendorId.get(vendor.id) ?? 0) + itemSubtotal,
      );
    }

    for (const [vendorId, additionalAmount] of additionalAmountByVendorId) {
      const vendor = await this.vendorsRepository.findById(vendorId);
      if (vendor) {
        await this.vendorPermissionsService.assertSalesLimitNotExceeded(
          vendorId,
          vendor.tier,
          additionalAmount,
        );
      }
    }

    // Resolved directly from the global PrismaService, not a DeliveryModule
    // import: DeliveryModule already imports OrdersModule, so importing it
    // back here would create a circular dependency. See ZoneResolutionService
    // for the equivalent lookup used within DeliveryModule itself.
    const zoneMapping = await this.prisma.deliveryZoneParish.findUnique({
      where: { parish: dto.deliveryParish },
      select: { zoneId: true },
    });
    const deliveryZoneId = zoneMapping?.zoneId ?? null;

    const order = await this.prisma.$transaction(async (tx) => {
      const vendorGroups = new Map<string, VendorOrderInput>();

      for (const item of cart.items) {
        await this.productsRepository.adjustStock(item.productId, -item.quantity, tx);

        const itemSubtotal = item.product.price.times(item.quantity);
        const existingGroup = vendorGroups.get(item.product.vendorId);
        const orderItem = {
          productId: item.productId,
          productName: item.product.name,
          unitPrice: item.product.price.toNumber(),
          unit: item.product.unit,
          quantity: item.quantity,
          subtotal: itemSubtotal.toNumber(),
        };

        if (existingGroup) {
          existingGroup.items.push(orderItem);
          existingGroup.subtotal += itemSubtotal.toNumber();
        } else {
          vendorGroups.set(item.product.vendorId, {
            vendorId: item.product.vendorId,
            subtotal: itemSubtotal.toNumber(),
            items: [orderItem],
          });
        }
      }

      const created = await this.ordersRepository.create(
        {
          customerId: userId,
          deliveryAddressLine1: dto.deliveryAddressLine1,
          deliveryAddressLine2: dto.deliveryAddressLine2,
          deliveryParish: dto.deliveryParish,
          deliveryPhone: dto.deliveryPhone,
          deliveryZoneId,
          vendorOrders: Array.from(vendorGroups.values()),
        },
        tx,
      );

      for (const vendorOrder of created.vendorOrders) {
        for (const item of vendorOrder.items) {
          await this.inventoryEventsRepository.create(
            {
              productId: item.productId,
              eventType: 'DECREMENTED',
              quantityDelta: -item.quantity,
              vendorOrderId: vendorOrder.id,
            },
            tx,
          );
        }
      }

      await this.cartRepository.clear(cart.id, tx);

      return created;
    });

    // No longer "reserved", it's actually decremented now - release the
    // soft holds for exactly the products just purchased so they stop
    // counting against other shoppers' availability.
    const purchasedProductIds = new Set(cart.items.map((item) => item.productId));
    for (const productId of purchasedProductIds) {
      await this.inventoryReservations.release(productId, cart.id);
    }

    const total = order.vendorOrders.reduce(
      (sum, vendorOrder) => sum + vendorOrder.subtotal.toNumber(),
      0,
    );
    const itemCount = order.vendorOrders.reduce(
      (count, vendorOrder) => count + vendorOrder.items.length,
      0,
    );
    await this.eventEmitter.emitAsync(
      OrderPlacedEvent.eventName,
      new OrderPlacedEvent(userId, order.id, total.toFixed(2), itemCount),
    );

    const { payment, redirectUrl } = await this.paymentsService.initiatePayment({
      orderId: order.id,
      amount: total,
      currency: 'JMD',
      provider: dto.paymentMethod,
    });

    return {
      ...OrdersService.toResponse(order),
      payment,
      paymentRedirectUrl: redirectUrl,
    };
  }

  async getCustomerOrders(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedOrdersEntity> {
    const { items, total } = await this.ordersRepository.findManyByCustomer(userId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    const withPayments = await Promise.all(items.map((order) => this.toResponseWithPayment(order)));

    return {
      items: withPayments,
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getCustomerOrderById(userId: string, orderId: string): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(order);
  }

  async cancelOrder(userId: string, orderId: string): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);

    const cancellable = order.vendorOrders.filter(
      (vendorOrder) => vendorOrder.status === CANCELLABLE_STATUS,
    );
    if (cancellable.length === 0) {
      throw new BadRequestException(
        'No part of this order is still pending, so none of it can be cancelled',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const vendorOrder of cancellable) {
        await this.restoreStockAndCancel(vendorOrder, tx);
      }
    });

    const updated = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(updated);
  }

  async cancelVendorOrder(
    userId: string,
    orderId: string,
    vendorOrderId: string,
  ): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);
    const vendorOrder = order.vendorOrders.find((candidate) => candidate.id === vendorOrderId);
    if (!vendorOrder) {
      throw new NotFoundException('Vendor order not found');
    }
    if (vendorOrder.status !== CANCELLABLE_STATUS) {
      throw new BadRequestException(
        'This part of the order has already been accepted and can no longer be cancelled',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.restoreStockAndCancel(vendorOrder, tx);
    });

    const updated = await this.getOwnedOrder(userId, orderId);
    return this.toResponseWithPayment(updated);
  }

  private async restoreStockAndCancel(
    vendorOrder: VendorOrder & { items: OrderItem[] },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const item of vendorOrder.items) {
      await this.productsRepository.adjustStock(item.productId, item.quantity, tx);
      await this.inventoryEventsRepository.create(
        {
          productId: item.productId,
          eventType: 'RESTOCKED',
          quantityDelta: item.quantity,
          vendorOrderId: vendorOrder.id,
        },
        tx,
      );
    }
    await this.vendorOrdersRepository.updateStatus(vendorOrder.id, 'CANCELLED');
  }

  private async getOwnedOrder(userId: string, orderId: string): Promise<OrderWithDetails> {
    const order = await this.ordersRepository.findById(orderId);
    if (!order || order.customerId !== userId) {
      throw new ForbiddenException('You do not have access to this order');
    }
    return order;
  }

  private async toResponseWithPayment(order: OrderWithDetails): Promise<OrderResponseEntity> {
    const payment = await this.paymentsService.getByOrderId(order.id);
    return { ...OrdersService.toResponse(order), payment: payment ?? undefined };
  }

  private static toResponse(order: OrderWithDetails): OrderResponseEntity {
    return {
      id: order.id,
      customerId: order.customerId,
      deliveryAddressLine1: order.deliveryAddressLine1,
      deliveryAddressLine2: order.deliveryAddressLine2,
      deliveryParish: order.deliveryParish,
      deliveryPhone: order.deliveryPhone,
      deliveryZoneId: order.deliveryZoneId,
      createdAt: order.createdAt,
      vendorOrders: order.vendorOrders.map((vendorOrder) => ({
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
      })),
    };
  }
}
