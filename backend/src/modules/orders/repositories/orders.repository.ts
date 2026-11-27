import { Injectable } from '@nestjs/common';
import { FleetAssetStatus, Parish, Prisma, ProductUnit } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const orderWithDetails = Prisma.validator<Prisma.OrderDefaultArgs>()({
  include: { vendorOrders: { include: { items: true }, orderBy: { createdAt: 'asc' } } },
});

export type OrderWithDetails = Prisma.OrderGetPayload<typeof orderWithDetails>;

const fleetAssetLocationSelect = Prisma.validator<Prisma.FleetAssetSelect>()({
  id: true,
  status: true,
  lastLatitude: true,
  lastLongitude: true,
  lastGpsCapturedAt: true,
  lastTelemetryReceivedAt: true,
  lastTelemetryDelayed: true,
  lastGpsNoFixAt: true,
});

// Scoped strictly to customer-safe fields so internal telemetry, fleet route history,
// driver contact details, and other customers' stops are never loaded for customer tracking.
const orderTrackingSelect = Prisma.validator<Prisma.OrderSelect>()({
  id: true,
  customerId: true,
  deliveryParish: true,
  vendorOrders: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      vendor: {
        select: {
          businessName: true,
        },
      },
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          productName: true,
          quantity: true,
        },
      },
      cargoAssignments: {
        orderBy: { loadedAt: 'desc' },
        select: {
          quantityUnits: true,
          handedOverQuantity: true,
          unloadedAt: true,
          fleetAsset: {
            select: fleetAssetLocationSelect,
          },
        },
      },
      delivery: {
        select: {
          pickedUpAt: true,
          deliveredAt: true,
          failedAt: true,
          customerAcceptanceStatus: true,
          customerRejectedAt: true,
          customerDeliveryWindowStart: true,
          customerDeliveryWindowEnd: true,
          runStop: {
            select: {
              deliveryRun: {
                select: {
                  fleetAsset: {
                    select: fleetAssetLocationSelect,
                  },
                },
              },
            },
          },
          driver: {
            select: {
              operatedFleetAssets: {
                where: { status: FleetAssetStatus.ACTIVE },
                take: 1,
                orderBy: { updatedAt: 'desc' },
                select: fleetAssetLocationSelect,
              },
            },
          },
        },
      },
    },
  },
});

export type OrderTrackingRecord = Prisma.OrderGetPayload<{ select: typeof orderTrackingSelect }>;

export interface VendorOrderItemInput {
  id?: string;
  productId: string;
  productName: string;
  unitPrice: Prisma.Decimal | number | string;
  unit: ProductUnit;
  quantity: number;
  subtotal: Prisma.Decimal | number | string;
  currency: string | null;
  originalLotId?: string | null;
  originalListingId?: string | null;
  purchaseSnapshot?: Prisma.InputJsonValue;
}

export interface VendorOrderInput {
  vendorId: string;
  subtotal: Prisma.Decimal | number | string;
  items: VendorOrderItemInput[];
}

export interface CreateOrderInput {
  customerId: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2?: string;
  deliveryParish: Parish;
  deliveryPhone: string;
  deliveryZoneId?: string | null;
  currency: string | null;
  vendorOrders: VendorOrderInput[];
}

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateOrderInput, client: PrismaClientOrTx = this.prisma): Promise<OrderWithDetails> {
    return client.order.create({
      data: {
        customerId: input.customerId,
        deliveryAddressLine1: input.deliveryAddressLine1,
        deliveryAddressLine2: input.deliveryAddressLine2,
        deliveryParish: input.deliveryParish,
        deliveryPhone: input.deliveryPhone,
        deliveryZoneId: input.deliveryZoneId,
        currency: input.currency,
        vendorOrders: {
          create: input.vendorOrders.map((vendorOrder) => ({
            vendorId: vendorOrder.vendorId,
            subtotal: vendorOrder.subtotal,
            items: { create: vendorOrder.items },
          })),
        },
      },
      include: orderWithDetails.include,
    });
  }

  findById(id: string): Promise<OrderWithDetails | null> {
    return this.prisma.order.findUnique({ where: { id }, include: orderWithDetails.include });
  }

  findOrderTrackingById(id: string): Promise<OrderTrackingRecord | null> {
    return this.prisma.order.findUnique({ where: { id }, select: orderTrackingSelect });
  }

  async findManyByCustomer(
    customerId: string,
    page: { skip: number; take: number },
  ): Promise<{ items: OrderWithDetails[]; total: number }> {
    const where: Prisma.OrderWhereInput = { customerId };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: orderWithDetails.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  count(range?: DateRange): Promise<number> {
    const where: Prisma.OrderWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};
    return this.prisma.order.count({ where });
  }
}
