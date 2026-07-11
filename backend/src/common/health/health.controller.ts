import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { HealthService, HealthStatus } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check API, database, and cache connectivity' })
  async check(): Promise<HealthStatus> {
    const { postgres, redis } = await this.healthService.checkStatus();

    if (postgres === 'down' || redis === 'down') {
      throw new HttpException(
        { message: 'One or more dependencies are unavailable', postgres, redis },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { postgres, redis };
  }
}
