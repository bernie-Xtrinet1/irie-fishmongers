import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';

import { compareByLocaleName } from '../../../common/utils/locale-name.util';
import { PrismaService } from '../../../database/prisma.service';

export interface CreateCategoryInput {
  name: string;
  slug: string;
}

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Ordered in the application (not via a DB `ORDER BY`) so the customer-facing
  // category list is collation-independent and identical across environments -
  // see compareByLocaleName. The list is small, so sorting in memory is fine.
  async findAll(): Promise<Category[]> {
    const categories = await this.prisma.category.findMany();
    return categories.sort((a, b) => compareByLocaleName(a.name, b.name));
  }

  findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  findBySlug(slug: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { slug } });
  }

  create(input: CreateCategoryInput): Promise<Category> {
    return this.prisma.category.create({ data: input });
  }
}
