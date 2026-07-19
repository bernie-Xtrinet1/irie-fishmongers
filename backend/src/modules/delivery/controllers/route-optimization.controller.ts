import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RoutePlanResponseEntity } from '../entities/route-plan-response.entity';
import { RouteOptimizationService } from '../services/route-optimization.service';

@ApiTags('delivery-zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('delivery/zones')
export class RouteOptimizationController {
  constructor(private readonly routeOptimizationService: RouteOptimizationService) {}

  @Post(':zoneId/optimize-route')
  @ApiOperation({
    summary:
      'Plan a driver route for scheduled, unclaimed-pickup deliveries in a zone (admin only; does not reassign drivers)',
  })
  @ApiResponseDoc({ status: 201, type: RoutePlanResponseEntity })
  optimizeRoute(@Param('zoneId') zoneId: string): Promise<RoutePlanResponseEntity> {
    return this.routeOptimizationService.optimizeRoute(zoneId);
  }
}
