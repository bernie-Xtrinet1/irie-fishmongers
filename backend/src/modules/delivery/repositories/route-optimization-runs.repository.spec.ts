import { PrismaService } from '../../../database/prisma.service';
import { RouteOptimizationRunsRepository } from './route-optimization-runs.repository';

describe('RouteOptimizationRunsRepository', () => {
  let prisma: PrismaService;
  let repository: RouteOptimizationRunsRepository;
  let zoneId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new RouteOptimizationRunsRepository(prisma);
    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zoneId = zone.id;
  });

  afterAll(async () => {
    await prisma.routeOptimizationRun.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('creates an audit record of a route-planning decision', async () => {
    const run = await repository.create({
      zoneId,
      strategyName: 'single-stop-default',
      deliveryIds: ['delivery-1', 'delivery-2'],
    });

    expect(run.zoneId).toBe(zoneId);
    expect(run.strategyName).toBe('single-stop-default');
    expect(run.deliveryIds).toEqual(['delivery-1', 'delivery-2']);
  });
});
