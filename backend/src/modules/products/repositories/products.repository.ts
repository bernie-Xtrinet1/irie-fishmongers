import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, ProductUnit } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

const productWithLot = Prisma.validator<Prisma.ProductDefaultArgs>()({
  include: { lot: true },
});

export type ProductWithLot = Prisma.ProductGetPayload<typeof productWithLot>;

export interface CreateProductInput {
  vendorId: string;
  categoryId: string;
  lotId?: string;
  name: string;
  description: string;
  unit: ProductUnit;
  price: number;
  quantityAvailable: number;
  imageUrl: string;
  weightLbs?: number;
}

export interface UpdateProductInput {
  categoryId?: string;
  name?: string;
  description?: string;
  unit?: ProductUnit;
  price?: number;
  imageUrl?: string;
  weightLbs?: number;
}

export interface ProductSearchFilters {
  categoryId?: string;
  vendorId?: string;
  search?: string;
  activeOnly: boolean;
}

export interface Page {
  skip: number;
  take: number;
}

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateProductInput): Promise<ProductWithLot> {
    return this.prisma.product.create({ data: input, include: productWithLot.include });
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<ProductWithLot | null> {
    return client.product.findUnique({ where: { id }, include: productWithLot.include });
  }

  update(id: string, input: UpdateProductInput): Promise<ProductWithLot> {
    return this.prisma.product.update({
      where: { id },
      data: input,
      include: productWithLot.include,
    });
  }

  setActive(id: string, isActive: boolean): Promise<ProductWithLot> {
    return this.prisma.product.update({
      where: { id },
      data: { isActive },
      include: productWithLot.include,
    });
  }

  async findMany(
    filters: ProductSearchFilters,
    page: Page,
  ): Promise<{ items: ProductWithLot[]; total: number }> {
    const conditions: Prisma.ProductWhereInput[] = [];

    if (filters.activeOnly) {
      conditions.push({ isActive: true });
      // A product tied to a lot that has been placed on hold, quarantined,
      // recalled, or rejected must not appear in customer-facing search,
      // even though it is otherwise "active" from a plain inventory sense.
      conditions.push({ OR: [{ lotId: null }, { lot: { foodSafetyStatus: 'SAFE' } }] });
    }
    if (filters.categoryId) {
      conditions.push({ categoryId: filters.categoryId });
    }
    if (filters.vendorId) {
      conditions.push({ vendorId: filters.vendorId });
    }
    if (filters.search) {
      conditions.push({
        OR: [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.ProductWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: productWithLot.include,
        skip: page.skip,
        take: page.take,
        orderBy: [{ quantityAvailable: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Atomically applies `delta` to quantityAvailable. The floor-at-zero guard is
   * enforced by the database in the same UPDATE (via the WHERE clause), not by
   * a prior read, so concurrent decrements (e.g. two checkouts racing for the
   * last units) can't both succeed and drive stock negative.
   */
  async adjustStock(
    id: string,
    delta: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<ProductWithLot> {
    if (delta < 0) {
      const result = await client.product.updateMany({
        where: { id, quantityAvailable: { gte: -delta } },
        data: { quantityAvailable: { increment: delta } },
      });
      if (result.count === 0) {
        throw new ConflictException('Resulting stock quantity cannot be negative');
      }
    } else {
      await client.product.update({
        where: { id },
        data: { quantityAvailable: { increment: delta } },
      });
    }

    return client.product.findUniqueOrThrow({ where: { id }, include: productWithLot.include });
  }

  // 12B Inventory Analytics: narrow select of exactly the fields
  // ProductsService.computeAvailability() needs - not the full ProductWithLot
  // shape - so tallying availability across the whole catalog doesn't pull
  // every product field into memory.
  findAllForAvailability(): Promise<
    { isActive: boolean; quantityAvailable: number; lot: Prisma.SeafoodLotGetPayload<{ select: typeof lotAvailabilitySelect }> | null }[]
  > {
    return this.prisma.product.findMany({
      select: { isActive: true, quantityAvailable: true, lot: { select: lotAvailabilitySelect } },
    });
  }

  // Active products running low but not yet at zero (zero is "out of
  // stock", already covered by the availability breakdown above) - the
  // operational "restock soon" list.
  findLowStock(
    threshold: number,
    limit: number,
  ): Promise<{ id: string; name: string; quantityAvailable: number; vendorId: string }[]> {
    return this.prisma.product.findMany({
      where: { isActive: true, quantityAvailable: { gt: 0, lte: threshold } },
      select: { id: true, name: true, quantityAvailable: true, vendorId: true },
      orderBy: { quantityAvailable: 'asc' },
      take: limit,
    });
  }
}

const lotAvailabilitySelect = {
  foodSafetyStatus: true,
  freshnessGrade: true,
  qualityScore: true,
} satisfies Prisma.SeafoodLotSelect;
