import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
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
import { UpdateFleetMaintenanceDto } from '../dto/update-fleet-maintenance.dto';
import { FleetMaintenanceResponseEntity } from '../entities/fleet-maintenance-response.entity';
import { FleetMaintenanceService } from '../services/fleet-maintenance.service';

@ApiTags('fleet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('fleet-maintenance')
export class FleetMaintenanceController {
  constructor(private readonly fleetMaintenanceService: FleetMaintenanceService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Update a fleet maintenance record (admin only)' })
  @ApiResponseDoc({ status: 200, type: FleetMaintenanceResponseEntity })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFleetMaintenanceDto,
  ): Promise<FleetMaintenanceResponseEntity> {
    return this.fleetMaintenanceService.update(id, dto);
  }
}
