import { Injectable } from '@nestjs/common';
import { Prisma, VendorOrderStatus } from '@prisma/client';

import { DateRange } from '../../../common/dto/date-range.type';
import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from './orders.repository';

const vendorOrderWithItems = Prisma.validator<Prisma.VendorOrderDefaultArgs>()({
  include: { items: true, order: true },
});

export type VendorOrderWithItems = Prisma.VendorOrderGetPayload<typeof vendorOrderWithItems>;

@Injectable()
export class VendorOrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<VendorOrderWithItems | null> {
    return this.prisma.vendorOrder.findUnique({
      where: { id },
      include: vendorOrderWithItems.include,
    });
  }

  updateStatus(
    id: string,
    status: VendorOrderStatus,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<VendorOrderWithItems> {
    return client.vendorOrder.update({
      where: { id },
      data: { status },
      include: vendorOrderWithItems.include,
    });
  }

  async findManyByVendor(
    vendorId: string,
    status: VendorOrderStatus | undefined,
    page: { skip: number; take: number },
  ): Promise<{ items: VendorOrderWithItems[]; total: number }> {
    const where: Prisma.VendorOrderWhereInput = {
      vendorId,
      ...(status ? { status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.vendorOrder.findMany({
        where,
        include: vendorOrderWithItems.include,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.vendorOrder.count({ where }),
    ]);

    return { items, total };
  }

  async countByStatus(range?: DateRange): Promise<Record<VendorOrderStatus, number>> {
    const where: Prisma.VendorOrderWhereInput =
      range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {};

    const groups = await this.prisma.vendorOrder.groupBy({ by: ['status'], where, _count: { _all: true } });

    const countByStatus: Record<VendorOrderStatus, number> = {
      PENDING: 0,
      ACCEPTED: 0,
      PREPARING: 0,
      READY_FOR_PICKUP: 0,
      ASSIGNED_TO_DRIVER: 0,
      IN_TRANSIT: 0,
      DELIVERED: 0,
      DELIVERY_FAILED: 0,
      REJECTED: 0,
      CANCELLED: 0,
    };
    for (const group of groups) {
      countByStatus[group.status] = group._count._all;
    }
    return countByStatus;
  }

  // 12B Sales Analytics: per-product quantity/revenue for only items whose
  // order was actually paid - matches getDashboardSummary()'s
  // "grossPaidAmount" semantics (PAID payments only, not every order ever
  // placed). Shared by getTopProductsByRevenue and getSalesByCategory below
  // so both read the exact same underlying sums.
  private groupItemsByProduct(range?: DateRange) {
    return this.prisma.orderItem.groupBy({
      by: ['productId'],
      _sum: { quantity: true, subtotal: true },
      where: {
        vendorOrder: { order: { payment: { status: 'PAID' } } },
        ...(range?.from || range?.to
          ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
          : {}),
      },
    });
  }

  // Product name is looked up fresh (not the OrderItem's snapshotted
  // productName) so a renamed product's historical sales all attribute to
  // its current name, mirroring VendorSettlementsRepository.
  // getTopVendorsByRevenue()'s two-query join pattern.
  async getTopProductsByRevenue(
    limit: number,
    range?: DateRange,
  ): Promise<{ productId: string; productName: string; quantitySold: number; revenue: string }[]> {
    const groups = await this.groupItemsByProduct(range);
    if (groups.length === 0) {
      return [];
    }

    const ranked = groups
      .map((group) => ({
        productId: group.productId,
        quantitySold: group._sum.quantity ?? 0,
        revenue: group._sum.subtotal ?? new Prisma.Decimal(0),
      }))
      .sort((a, b) => b.revenue.comparedTo(a.revenue))
      .slice(0, limit);

    const products = await this.prisma.product.findMany({
      where: { id: { in: ranked.map((entry) => entry.productId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(products.map((product) => [product.id, product.name]));

    return ranked.map((entry) => ({
      productId: entry.productId,
      productName: nameById.get(entry.productId) ?? 'Unknown product',
      quantitySold: entry.quantitySold,
      revenue: entry.revenue.toString(),
    }));
  }

  async getSalesByCategory(
    range?: DateRange,
  ): Promise<{ categoryId: string; categoryName: string; quantitySold: number; revenue: string }[]> {
    const groups = await this.groupItemsByProduct(range);
    if (groups.length === 0) {
      return [];
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: groups.map((group) => group.productId) } },
      select: { id: true, categoryId: true, category: { select: { name: true } } },
    });
    const categoryByProductId = new Map(products.map((product) => [product.id, product]));

    const totalsByCategory = new Map<string, { categoryName: string; quantitySold: number; revenue: Prisma.Decimal }>();
    for (const group of groups) {
      const product = categoryByProductId.get(group.productId);
      if (!product) {
        continue;
      }
      const existing = totalsByCategory.get(product.categoryId) ?? {
        categoryName: product.category.name,
        quantitySold: 0,
        revenue: new Prisma.Decimal(0),
      };
      existing.quantitySold += group._sum.quantity ?? 0;
      existing.revenue = existing.revenue.plus(group._sum.subtotal ?? new Prisma.Decimal(0));
      totalsByCategory.set(product.categoryId, existing);
    }

    return Array.from(totalsByCategory.entries())
      .map(([categoryId, totals]) => ({
        categoryId,
        categoryName: totals.categoryName,
        quantitySold: totals.quantitySold,
        revenue: totals.revenue.toString(),
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));
  }
}
