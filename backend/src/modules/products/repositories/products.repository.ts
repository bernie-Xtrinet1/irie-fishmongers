import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, Product, ProductUnit } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export interface CreateProductInput {
  vendorId: string;
  categoryId: string;
  name: string;
  description: string;
  unit: ProductUnit;
  price: number;
  quantityAvailable: number;
  imageUrl: string;
}

export interface UpdateProductInput {
  categoryId?: string;
  name?: string;
  description?: string;
  unit?: ProductUnit;
  price?: number;
  imageUrl?: string;
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

  create(input: CreateProductInput): Promise<Product> {
    return this.prisma.product.create({ data: input });
  }

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<Product | null> {
    return client.product.findUnique({ where: { id } });
  }

  update(id: string, input: UpdateProductInput): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data: input });
  }

  setActive(id: string, isActive: boolean): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data: { isActive } });
  }

  async findMany(
    filters: ProductSearchFilters,
    page: Page,
  ): Promise<{ items: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...(filters.activeOnly ? { isActive: true } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { description: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
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
  ): Promise<Product> {
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

    return client.product.findUniqueOrThrow({ where: { id } });
  }
}
