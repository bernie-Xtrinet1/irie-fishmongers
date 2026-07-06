import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, Product, ProductUnit } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

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

  findById(id: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id } });
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

  async adjustStock(id: string, delta: number): Promise<Product> {
    // Read-then-write is acceptable while nothing else mutates stock concurrently
    // (no Orders module yet). Revisit with an atomic guarded UPDATE once concurrent
    // order placement can decrement stock at the same time.
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id } });
    const nextQuantity = product.quantityAvailable + delta;

    if (nextQuantity < 0) {
      throw new ConflictException('Resulting stock quantity cannot be negative');
    }

    return this.prisma.product.update({
      where: { id },
      data: { quantityAvailable: nextQuantity },
    });
  }
}
