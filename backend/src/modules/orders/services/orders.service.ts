import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderItem, Prisma, VendorOrder } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
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
  ) {}

  async checkout(userId: string, dto: CheckoutDto): Promise<OrderResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    if (cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    for (const item of cart.items) {
      if (!item.product.isActive) {
        throw new BadRequestException(`"${item.product.name}" is no longer available`);
      }
      const vendor = await this.vendorsRepository.findById(item.product.vendorId);
      if (!vendor || vendor.status !== 'APPROVED') {
        throw new BadRequestException(
          `"${item.product.name}" is not currently sold by an approved vendor`,
        );
      }
    }

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
          vendorOrders: Array.from(vendorGroups.values()),
        },
        tx,
      );

      await this.cartRepository.clear(cart.id, tx);

      return created;
    });

    return OrdersService.toResponse(order);
  }

  async getCustomerOrders(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedOrdersEntity> {
    const { items, total } = await this.ordersRepository.findManyByCustomer(userId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((order) => OrdersService.toResponse(order)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getCustomerOrderById(userId: string, orderId: string): Promise<OrderResponseEntity> {
    const order = await this.getOwnedOrder(userId, orderId);
    return OrdersService.toResponse(order);
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
    return OrdersService.toResponse(updated);
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
    return OrdersService.toResponse(updated);
  }

  private async restoreStockAndCancel(
    vendorOrder: VendorOrder & { items: OrderItem[] },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const item of vendorOrder.items) {
      await this.productsRepository.adjustStock(item.productId, item.quantity, tx);
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

  private static toResponse(order: OrderWithDetails): OrderResponseEntity {
    return {
      id: order.id,
      customerId: order.customerId,
      deliveryAddressLine1: order.deliveryAddressLine1,
      deliveryAddressLine2: order.deliveryAddressLine2,
      deliveryParish: order.deliveryParish,
      deliveryPhone: order.deliveryPhone,
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
