import { Injectable } from '@nestjs/common';
import { CustomerAcceptanceStatus, Prisma, ProofOfDeliveryType } from '@prisma/client';

import { PrismaClientOrTx } from '../../orders/repositories/orders.repository';
import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

const availableVendorOrder = Prisma.validator<Prisma.VendorOrderDefaultArgs>()({
  include: { vendor: true, items: true },
});

export type AvailableVendorOrder = Prisma.VendorOrderGetPayload<typeof availableVendorOrder>;

const deliveryWithDetails = Prisma.validator<Prisma.DeliveryDefaultArgs>()({
  include: {
    driver: { include: { user: true } },
    vendorOrder: { include: { order: true, vendor: true, items: true } },
    exceptions: { orderBy: { createdAt: 'desc' } },
    routeHistory: true,
  },
});

export type DeliveryWithDetails = Prisma.DeliveryGetPayload<typeof deliveryWithDetails>;

const deliveryForMetrics = Prisma.validator<Prisma.DeliveryDefaultArgs>()({
  select: {
    id: true,
    assignedAt: true,
    pickedUpAt: true,
    deliveredAt: true,
    failedAt: true,
    customerDeliveryWindowEnd: true,
    customerAcceptanceStatus: true,
    routeHistory: { select: { durationMinutes: true } },
    vendorOrder: { select: { items: { select: { product: { select: { lotId: true } } } } } },
  },
});

export type DeliveryForMetrics = Prisma.DeliveryGetPayload<typeof deliveryForMetrics>;

export interface Page {
  skip: number;
  take: number;
}

export interface UpdateDeliveryScheduleInput {
  scheduledPickupWindowStart?: Date;
  scheduledPickupWindowEnd?: Date;
  customerDeliveryWindowStart?: Date;
  customerDeliveryWindowEnd?: Date;
}

export interface RecordCustomerAcceptanceInput {
  customerAcceptanceStatus: CustomerAcceptanceStatus;
  customerAcceptedAt?: Date;
  customerRejectedAt?: Date;
  rejectionReason?: string;
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

  async vendorOrderRequiresColdChain(vendorOrderId: string): Promise<boolean> {
    const count = await this.prisma.orderItem.count({
      where: { vendorOrderId, product: { lot: { isNot: null } } },
    });
    return count > 0;
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

  updateSchedule(id: string, input: UpdateDeliveryScheduleInput): Promise<DeliveryWithDetails> {
    return this.prisma.delivery.update({
      where: { id },
      data: input,
      include: deliveryWithDetails.include,
    });
  }

  confirmVendorPickup(id: string, confirmedById: string): Promise<DeliveryWithDetails> {
    return this.prisma.delivery.update({
      where: { id },
      data: { vendorConfirmedAt: new Date(), vendorConfirmedById: confirmedById },
      include: deliveryWithDetails.include,
    });
  }

  recordCustomerAcceptance(
    id: string,
    input: RecordCustomerAcceptanceInput,
  ): Promise<DeliveryWithDetails> {
    return this.prisma.delivery.update({
      where: { id },
      data: input,
      include: deliveryWithDetails.include,
    });
  }

  // "Scheduled" here means an active, unclaimed-pickup delivery (a Delivery
  // row exists, not yet picked up) heading to the given zone - the set a
  // dispatcher would plan a route over, per the customer's zone-resolved
  // delivery address (Order.deliveryZoneId).
  findScheduledForZone(zoneId: string): Promise<DeliveryWithDetails[]> {
    return this.prisma.delivery.findMany({
      where: {
        pickedUpAt: null,
        deliveredAt: null,
        failedAt: null,
        vendorOrder: { order: { deliveryZoneId: zoneId } },
      },
      include: deliveryWithDetails.include,
      orderBy: { assignedAt: 'asc' },
    });
  }

  findAllByDriverForMetrics(driverId: string): Promise<DeliveryForMetrics[]> {
    return this.prisma.delivery.findMany({
      where: { driverId },
      select: deliveryForMetrics.select,
    });
  }

  // 12B Delivery Analytics: how customers are responding to completed
  // deliveries - not covered by any existing dashboard (order status
  // breakdowns only track the vendor/driver side of the lifecycle).
  async countByCustomerAcceptanceStatus(range?: DateRange): Promise<Record<CustomerAcceptanceStatus, number>> {
    const where: Prisma.DeliveryWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};

    const groups = await this.prisma.delivery.groupBy({
      by: ['customerAcceptanceStatus'],
      where,
      _count: { _all: true },
    });

    const countByStatus: Record<CustomerAcceptanceStatus, number> = {
      PENDING: 0,
      ACCEPTED: 0,
      REJECTED: 0,
    };
    for (const group of groups) {
      countByStatus[group.customerAcceptanceStatus] = group._count._all;
    }
    return countByStatus;
  }
}
