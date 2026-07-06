import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateCategoryInput {
  name: string;
  slug: string;
}

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
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
