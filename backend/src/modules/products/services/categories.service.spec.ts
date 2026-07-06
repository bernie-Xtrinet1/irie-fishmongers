import { ConflictException } from '@nestjs/common';
import { Category } from '@prisma/client';

import { CategoriesRepository } from '../repositories/categories.repository';
import { CategoriesService } from './categories.service';

const category: Category = {
  id: 'cat-1',
  name: 'Fish',
  slug: 'fish',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('CategoriesService', () => {
  let categoriesRepository: jest.Mocked<Pick<CategoriesRepository, 'findAll' | 'findBySlug' | 'create'>>;
  let service: CategoriesService;

  beforeEach(() => {
    categoriesRepository = {
      findAll: jest.fn(),
      findBySlug: jest.fn(),
      create: jest.fn(),
    };
    service = new CategoriesService(categoriesRepository as unknown as CategoriesRepository);
  });

  it('lists all categories', async () => {
    categoriesRepository.findAll.mockResolvedValue([category]);
    await expect(service.findAll()).resolves.toEqual([category]);
  });

  it('creates a category when the slug is unused', async () => {
    categoriesRepository.findBySlug.mockResolvedValue(null);
    categoriesRepository.create.mockResolvedValue(category);

    await expect(service.create({ name: 'Fish', slug: 'fish' })).resolves.toEqual(category);
  });

  it('rejects a duplicate slug', async () => {
    categoriesRepository.findBySlug.mockResolvedValue(category);

    await expect(service.create({ name: 'Fish', slug: 'fish' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
