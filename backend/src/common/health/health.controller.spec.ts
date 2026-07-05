import { HttpException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let prisma: jest.Mocked<Pick<PrismaService, '$queryRaw'>>;
  let redis: jest.Mocked<Pick<RedisService, 'ping'>>;
  let controller: HealthController;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() };
    redis = { ping: jest.fn() };
    controller = new HealthController(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
  });

  it('reports both dependencies up', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    await expect(controller.check()).resolves.toEqual({ postgres: 'up', redis: 'up' });
  });

  it('throws 503 when postgres is unreachable', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');

    await expect(controller.check()).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 503 when redis is unreachable', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockRejectedValue(new Error('connection refused'));

    await expect(controller.check()).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 503 when redis replies with something other than PONG', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('unexpected');

    await expect(controller.check()).rejects.toBeInstanceOf(HttpException);
  });
});
