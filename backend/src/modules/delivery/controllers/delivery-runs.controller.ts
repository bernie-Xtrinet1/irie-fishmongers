import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import { AssignDeliveryRunDto } from '../dto/assign-delivery-run.dto';
import { DeliveryRunResponseEntity } from '../entities/delivery-run-response.entity';
import { DeliveryRunsService } from '../services/delivery-runs.service';

@ApiTags('delivery-runs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('delivery-runs')
export class DeliveryRunsController {
  constructor(private readonly deliveryRunsService: DeliveryRunsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a delivery run and its ordered stops (admin only)' })
  @ApiResponseDoc({ status: 200, type: DeliveryRunResponseEntity })
  getById(@Param('id') id: string): Promise<DeliveryRunResponseEntity> {
    return this.deliveryRunsService.getById(id);
  }

  @Patch(':id/assign')
  @ApiOperation({
    summary: 'Assign a driver (and optional fleet asset) to a planned delivery run (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: DeliveryRunResponseEntity })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignDeliveryRunDto,
  ): Promise<DeliveryRunResponseEntity> {
    return this.deliveryRunsService.assign(id, dto);
  }
}
