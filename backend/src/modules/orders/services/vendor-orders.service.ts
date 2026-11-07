import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { VendorOrderStatus } from '@prisma/client';

import { OrderAcceptedEvent } from '../../../common/events/order-accepted.event';
import { PrismaService } from '../../../database/prisma.service';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
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
  DELIVERY_FAILED: [],
  REJECTED: [],
  CANCELLED: [],
};

@Injectable()
export class VendorOrdersService {
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

    const updated = await this.prisma.$transaction(async (tx) => {
      if ((tx as any).vendorOrder?.updateMany) {
        const updateRes = await (tx as any).vendorOrder.updateMany({
          where: { id: vendorOrder.id, status: 'PENDING' },
          data: { status: 'REJECTED' },
        });
        if (updateRes.count === 0) {
          throw new ConflictException(
            `Vendor order "${vendorOrder.id}" is not in PENDING status or was concurrently modified.`,
          );
        }
      }

      // Canonical row locking: Products first, sorted by ID
      if ((tx as any).$queryRaw) {
        const sortedProductIds = [...new Set(vendorOrder.items.map((i) => i.productId))].sort();
        for (const pid of sortedProductIds) {
          await (tx as any).$queryRaw`SELECT id FROM products WHERE id = ${pid} FOR UPDATE`;
        }

        // Then VendorDailyListings, sorted by ID
        const listingIds = [...new Set(vendorOrder.items.map((i) => i.originalListingId).filter(Boolean) as string[])].sort();
        for (const lid of listingIds) {
          await (tx as any).$queryRaw`SELECT id FROM vendor_daily_listings WHERE id = ${lid} FOR UPDATE`;
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
          } else {
            if ((tx as any).$executeRaw) {
              await (tx as any).$executeRaw`
                UPDATE vendor_daily_listings
                SET "quantitySold" = "quantitySold" - ${item.quantity}::decimal
                WHERE id = ${item.originalListingId} AND "quantitySold" >= ${item.quantity}::decimal
              `;
            }
            await this.inventoryEventsRepository.create(
              {
                productId: item.productId,
                eventType: 'DISPOSED',
                quantityDelta: -item.quantity,
                vendorOrderId: vendorOrder.id,
                notes: JSON.stringify({
                  disposition: 'EXPIRED_ON_REJECT',
                  listingId: item.originalListingId,
                  orderItemId: item.id,
                  quantityDisposed: item.quantity,
                }),
              },
              tx,
            );
          }
        } else {
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
      }

      return this.vendorOrdersRepository.updateStatus(vendorOrder.id, 'REJECTED', tx);
    });

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
