import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../database/prisma.service';

// Reads directly against Product/VendorOrder (owned by ProductsModule/
// OrdersModule) the same way VendorSettlementsRepository already does,
// rather than importing those modules - avoids a circular module
// dependency (ProductsModule/OrdersModule both need to import
// VendorTiersModule for enforcement).
@Injectable()
export class VendorSalesRepository {
  constructor(private readonly prisma: PrismaService) {}

  countActiveListings(vendorId: string): Promise<number> {
    return this.prisma.product.count({ where: { vendorId, isActive: true } });
  }

  async sumVendorOrderSubtotalsSince(vendorId: string, since: Date): Promise<number> {
    const result = await this.prisma.vendorOrder.aggregate({
      where: {
        vendorId,
        createdAt: { gte: since },
        status: { notIn: ['REJECTED', 'CANCELLED'] },
      },
      _sum: { subtotal: true },
    });
    return result._sum.subtotal?.toNumber() ?? 0;
  }
}
