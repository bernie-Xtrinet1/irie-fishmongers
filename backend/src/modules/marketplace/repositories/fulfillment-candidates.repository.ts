import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const candidateWithVendorAndLot = Prisma.validator<Prisma.ProductDefaultArgs>()({
  include: { vendor: true, lot: true },
});

export type ProductCandidate = Prisma.ProductGetPayload<typeof candidateWithVendorAndLot>;

// Deliberately queries the Product table directly via PrismaService rather
// than depending on ProductsModule's ProductsRepository - ProductsModule
// already imports MarketplaceModule (for the Product Detail Page's mode
// data), so MarketplaceModule importing ProductsModule back would be a
// circular module dependency, the same class of issue avoided elsewhere in
// this codebase (see docs/database-design.md's Vendor Tier Tables note).
@Injectable()
export class FulfillmentCandidatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(productId: string): Promise<ProductCandidate | null> {
    return this.prisma.product.findUnique({
      where: { id: productId },
      include: candidateWithVendorAndLot.include,
    });
  }

  // "Best Available Vendor" cross-vendor matching: there is no canonical
  // species/product catalog independent of Product.vendorId, so equivalent
  // listings are matched by case-insensitive name + same category - a real,
  // functional heuristic (see docs/database-design.md's scope note).
  findMatchingCandidates(name: string, categoryId: string): Promise<ProductCandidate[]> {
    return this.prisma.product.findMany({
      where: {
        categoryId,
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
      },
      include: candidateWithVendorAndLot.include,
    });
  }
}
