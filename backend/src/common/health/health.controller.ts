import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../redis/redis.service';

interface HealthStatus {
  postgres: 'up' | 'down';
  redis: 'up' | 'down';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Check API, database, and cache connectivity' })
  async check(): Promise<HealthStatus> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);

    if (postgres === 'down' || redis === 'down') {
      throw new HttpException(
        { message: 'One or more dependencies are unavailable', postgres, redis },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

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
