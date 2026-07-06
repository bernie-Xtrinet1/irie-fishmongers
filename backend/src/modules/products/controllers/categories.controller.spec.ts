import { Category } from '@prisma/client';

import { CategoriesService } from '../services/categories.service';
import { CategoriesController } from './categories.controller';

const category: Category = {
  id: 'cat-1',
  name: 'Fish',
  slug: 'fish',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('CategoriesController', () => {
  let categoriesService: jest.Mocked<Pick<CategoriesService, 'findAll' | 'create'>>;
  let controller: CategoriesController;

  beforeEach(() => {
    categoriesService = {
      findAll: jest.fn().mockResolvedValue([category]),
      create: jest.fn().mockResolvedValue(category),
    };
    controller = new CategoriesController(categoriesService as unknown as CategoriesService);
  });

  it('lists categories', async () => {
    await expect(controller.findAll()).resolves.toEqual([category]);
  });

  it('creates a category', async () => {
    await expect(controller.create({ name: 'Fish', slug: 'fish' })).resolves.toEqual(category);
  });
});
