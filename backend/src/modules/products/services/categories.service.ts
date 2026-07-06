import { ConflictException, Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';

import { CreateCategoryDto } from '../dto/create-category.dto';
import { CategoriesRepository } from '../repositories/categories.repository';

@Injectable()
export class CategoriesService {
  constructor(private readonly categoriesRepository: CategoriesRepository) {}

  findAll(): Promise<Category[]> {
    return this.categoriesRepository.findAll();
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    const existing = await this.categoriesRepository.findBySlug(dto.slug);
    if (existing) {
      throw new ConflictException(`Category with slug "${dto.slug}" already exists`);
    }
    return this.categoriesRepository.create(dto);
  }
}
