import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { VendorOrderStatus } from '@prisma/client';

import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorOrderResponseEntity } from '../entities/vendor-order-response.entity';
import { PaginatedVendorOrdersEntity } from '../entities/paginated-vendor-orders.entity';
import { VendorOrderWithItems, VendorOrdersRepository } from '../repositories/vendor-orders.repository';

const ALLOWED_TRANSITIONS: Record<VendorOrderStatus, VendorOrderStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING'],
  PREPARING: ['READY_FOR_PICKUP'],
  READY_FOR_PICKUP: [],
  ASSIGNED_TO_DRIVER: [],
  IN_TRANSIT: [],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
};

@Injectable()
export class VendorOrdersService {
  constructor(
    private readonly vendorOrdersRepository: VendorOrdersRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly paymentsService: PaymentsService,
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
    return VendorOrdersService.toResponse(updated);
  }

  async reject(userId: string, vendorOrderId: string): Promise<VendorOrderResponseEntity> {
    const vendorOrder = await this.getOwnedVendorOrder(userId, vendorOrderId);
    this.assertTransitionAllowed(vendorOrder.status, 'REJECTED');

    for (const item of vendorOrder.items) {
      await this.productsRepository.adjustStock(item.productId, item.quantity);
    }

    const updated = await this.vendorOrdersRepository.updateStatus(vendorOrder.id, 'REJECTED');
    await this.paymentsService.refundForOrder(
      vendorOrder.orderId,
      vendorOrder.subtotal.toNumber(),
      'Vendor rejected order',
    );
    return VendorOrdersService.toResponse(updated);
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
