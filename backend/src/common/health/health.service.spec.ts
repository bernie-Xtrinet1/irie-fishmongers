import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let prisma: jest.Mocked<Pick<PrismaService, '$queryRaw'>>;
  let redis: jest.Mocked<Pick<RedisService, 'ping'>>;
  let service: HealthService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() };
    redis = { ping: jest.fn() };
    service = new HealthService(prisma as unknown as PrismaService, redis as unknown as RedisService);
  });

  it('reports both dependencies up', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    await expect(service.checkStatus()).resolves.toEqual({ postgres: 'up', redis: 'up' });
  });

  it('reports postgres down without affecting the redis result', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');

    await expect(service.checkStatus()).resolves.toEqual({ postgres: 'down', redis: 'up' });
  });

  it('reports redis down without affecting the postgres result', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockRejectedValue(new Error('connection refused'));

    await expect(service.checkStatus()).resolves.toEqual({ postgres: 'up', redis: 'down' });
  });

  it('reports redis down when it replies with something other than PONG', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('unexpected');

    await expect(service.checkStatus()).resolves.toEqual({ postgres: 'up', redis: 'down' });
  });
});
