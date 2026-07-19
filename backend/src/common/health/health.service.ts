import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface HealthStatus {
  postgres: 'up' | 'down';
  redis: 'up' | 'down';
}

// Extracted out of HealthController so AnalyticsService can reuse the same
// connectivity checks for its systemHealth KPI. Each check is isolated in
// its own try/catch and always resolves rather than throwing - a Redis
// outage must never take down a caller that also needs the Postgres
// result (or vice versa).
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async checkStatus(): Promise<HealthStatus> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    return { postgres, redis };
  }

  private async checkPostgres(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      const reply = await this.redis.ping();
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
