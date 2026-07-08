import { Injectable, NotFoundException } from '@nestjs/common';
import { VendorOrderStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { PickupQueueEntryEntity } from '../entities/pickup-queue-entry.entity';
import { VendorsRepository } from '../repositories/vendors.repository';

const PICKUP_QUEUE_STATUSES: VendorOrderStatus[] = ['READY_FOR_PICKUP', 'ASSIGNED_TO_DRIVER'];

/**
 * Reads across VendorOrder/Delivery/DeliveryRunStop directly via the global
 * PrismaService rather than importing OrdersModule/DeliveryModule -
 * VendorsModule staying leaf-level avoids a cycle (OrdersModule already
 * imports VendorsModule for checkout vendor lookups).
 */
@Injectable()
export class VendorPickupQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async getForUser(userId: string): Promise<PickupQueueEntryEntity[]> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }

    const vendorOrders = await this.prisma.vendorOrder.findMany({
      where: { vendorId: vendor.id, status: { in: PICKUP_QUEUE_STATUSES } },
      include: {
        delivery: {
          include: {
            driver: { include: { user: true } },
            runStop: true,
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
    });

    return vendorOrders.map((vendorOrder) => ({
      vendorOrderId: vendorOrder.id,
      status: vendorOrder.status,
      driverName: vendorOrder.delivery
        ? `${vendorOrder.delivery.driver.user.firstName} ${vendorOrder.delivery.driver.user.lastName}`
        : null,
      scheduledPickupWindowStart: vendorOrder.delivery?.scheduledPickupWindowStart ?? null,
      pickupOrder: vendorOrder.delivery?.runStop?.sequence ?? null,
    }));
  }
}
