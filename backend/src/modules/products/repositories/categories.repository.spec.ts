import { randomUUID } from 'crypto';

import { compareByLocaleName } from '../../../common/utils/locale-name.util';
import { PrismaService } from '../../../database/prisma.service';
import { CategoriesRepository } from './categories.repository';

describe('CategoriesRepository', () => {
  let prisma: PrismaService;
  let repository: CategoriesRepository;
  const createdIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new CategoriesRepository(prisma);
  });

  afterEach(async () => {
    if (createdIds.length > 0) {
      await prisma.category.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('creates and finds a category by id and slug', async () => {
    const slug = `test-${randomUUID()}`;
    const created = await repository.create({ name: 'Test Category', slug });
    createdIds.push(created.id);

    await expect(repository.findById(created.id)).resolves.toEqual(created);
    await expect(repository.findBySlug(slug)).resolves.toEqual(created);
  });

  it('returns null when a category cannot be found', async () => {
    await expect(repository.findBySlug(`missing-${randomUUID()}`)).resolves.toBeNull();
  });

  it('lists categories ordered by name, including the seeded defaults', async () => {
    const categories = await repository.findAll();
    const names = categories.map((category) => category.name);
    // Same comparator the repository sorts with, so ordering is asserted against
    // the exact production rule rather than the database's collation.
    expect(names).toEqual([...names].sort(compareByLocaleName));
    expect(names).toEqual(expect.arrayContaining(['Fish', 'Shellfish']));
  });
});
