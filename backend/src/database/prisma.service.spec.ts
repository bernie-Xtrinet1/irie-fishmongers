import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(() => {
    service = new PrismaService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('connects to PostgreSQL on module init', async () => {
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.$queryRaw`SELECT 1`).resolves.toEqual([{ '?column?': 1 }]);
  });
});
