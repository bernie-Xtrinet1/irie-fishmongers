import { Injectable } from '@nestjs/common';
import { Prisma, ProofOfDeliveryType } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { PrismaService } from '../../../database/prisma.service';

const availableVendorOrder = Prisma.validator<Prisma.VendorOrderDefaultArgs>()({
  include: { vendor: true, items: true },
});

export type AvailableVendorOrder = Prisma.VendorOrderGetPayload<typeof availableVendorOrder>;

const deliveryWithDetails = Prisma.validator<Prisma.DeliveryDefaultArgs>()({
  include: {
    driver: { include: { user: true } },
    vendorOrder: { include: { order: true, vendor: true, items: true } },
  },
});

export type DeliveryWithDetails = Prisma.DeliveryGetPayload<typeof deliveryWithDetails>;

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class DeliveriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAvailableForPickup(
    page: Page,
  ): Promise<{ items: AvailableVendorOrder[]; total: number }> {
    const where: Prisma.VendorOrderWhereInput = { status: 'READY_FOR_PICKUP', delivery: null };

    const [items, total] = await Promise.all([
      this.prisma.vendorOrder.findMany({
        where,
        include: availableVendorOrder.include,
        orderBy: { updatedAt: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorOrder.count({ where }),
    ]);

    return { items, total };
  }

  findVendorOrderForPickup(vendorOrderId: string): Promise<AvailableVendorOrder | null> {
    return this.prisma.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      include: availableVendorOrder.include,
    });
  }

  create(
    input: { vendorOrderId: string; driverId: string },
    client: PrismaClientOrTx = this.prisma,
  ): Promise<DeliveryWithDetails> {
    return client.delivery.create({ data: input, include: deliveryWithDetails.include });
  }

  findById(id: string): Promise<DeliveryWithDetails | null> {
    return this.prisma.delivery.findUnique({
      where: { id },
      include: deliveryWithDetails.include,
    });
  }

  findByVendorOrderId(vendorOrderId: string): Promise<DeliveryWithDetails | null> {
    return this.prisma.delivery.findUnique({
      where: { vendorOrderId },
      include: deliveryWithDetails.include,
    });
  }

  countActiveByDriverId(driverId: string): Promise<number> {
    return this.prisma.delivery.count({
      where: { driverId, deliveredAt: null, failedAt: null },
    });
  }

  async findManyByDriver(
    driverId: string,
    page: Page,
  ): Promise<{ items: DeliveryWithDetails[]; total: number }> {
    const where: Prisma.DeliveryWhereInput = { driverId };

    const [items, total] = await Promise.all([
      this.prisma.delivery.findMany({
        where,
        include: deliveryWithDetails.include,
        orderBy: { assignedAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.delivery.count({ where }),
    ]);

    return { items, total };
  }

  markPickedUp(id: string, client: PrismaClientOrTx = this.prisma): Promise<DeliveryWithDetails> {
    return client.delivery.update({
      where: { id },
      data: { pickedUpAt: new Date() },
      include: deliveryWithDetails.include,
    });
  }

  markDelivered(
    id: string,
    proofType: ProofOfDeliveryType,
    proofUrl: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<DeliveryWithDetails> {
    return client.delivery.update({
      where: { id },
      data: { deliveredAt: new Date(), proofType, proofUrl },
      include: deliveryWithDetails.include,
    });
  }

  markFailed(
    id: string,
    failureReason: string,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<DeliveryWithDetails> {
    return client.delivery.update({
      where: { id },
      data: { failedAt: new Date(), failureReason },
      include: deliveryWithDetails.include,
    });
  }
}
