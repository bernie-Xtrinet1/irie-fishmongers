import { Controller, Get, HttpException, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../decorators/roles.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { HealthService, HealthStatus } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check API, database, and cache connectivity (infra readiness probe - throws 503)' })
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

  // Always resolves 200 with the granular per-service status, unlike the
  // infra probe above which throws 503 on any outage. Used by the admin
  // dashboard's connectivity indicator/widget, polled independently and
  // far more frequently than the full analytics dashboard-summary
  // aggregation - it must stay cheap (two ping-style checks) regardless of
  // poll frequency, never recompute business KPIs.
  @Get('status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin dashboard connectivity widget status - always 200, admin only' })
  checkStatus(): Promise<HealthStatus> {
    return this.healthService.checkStatus();
  }
}
