import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { DeliveryRunResponseEntity } from '../../delivery/entities/delivery-run-response.entity';
import { DispatchService } from '../services/dispatch.service';

@ApiTags('dispatch')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('delivery-runs')
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  @Post(':id/dispatch')
  @ApiOperation({
    summary:
      'Automatically rank and assign the best available driver/fleet asset to a planned delivery run (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: DeliveryRunResponseEntity })
  dispatch(@Param('id') id: string): Promise<DeliveryRunResponseEntity> {
    return this.dispatchService.dispatch(id);
  }
}
