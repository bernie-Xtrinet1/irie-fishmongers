import { RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RolesRepository } from './roles.repository';

describe('RolesRepository', () => {
  let prisma: PrismaService;
  let repository: RolesRepository;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new RolesRepository(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it.each([RoleName.CUSTOMER, RoleName.VENDOR, RoleName.DRIVER, RoleName.ADMINISTRATOR])(
    'finds the seeded %s role by name',
    async (name) => {
      const role = await repository.findByName(name);
      expect(role?.name).toBe(name);
    },
  );
});
