import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListEmergencyResponsesDto } from '../dto/list-emergency-responses.dto';
import { UpdateEmergencyResponseStatusDto } from '../dto/update-emergency-response-status.dto';
import { EmergencyResponseResponseEntity } from '../entities/emergency-response-response.entity';
import { EmergencyResponsesService } from '../services/emergency-responses.service';

@ApiTags('compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('food-safety/emergency-responses')
export class EmergencyResponsesController {
  constructor(private readonly responsesService: EmergencyResponsesService) {}

  @Get()
  @ApiOperation({ summary: 'List emergency responses, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: EmergencyResponseResponseEntity, isArray: true })
  list(@Query() dto: ListEmergencyResponsesDto): Promise<EmergencyResponseResponseEntity[]> {
    return this.responsesService.list(dto.status);
  }

  @Patch(':id/acknowledge')
  @ApiOperation({ summary: 'Acknowledge an OPEN emergency response and self-assign it (admin only)' })
  @ApiResponseDoc({ status: 200, type: EmergencyResponseResponseEntity })
  acknowledge(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<EmergencyResponseResponseEntity> {
    return this.responsesService.acknowledge(user.id, id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Advance an emergency response to CONTAINED or RESOLVED (admin only)' })
  @ApiResponseDoc({ status: 200, type: EmergencyResponseResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateEmergencyResponseStatusDto,
  ): Promise<EmergencyResponseResponseEntity> {
    return this.responsesService.updateStatus(id, dto);
  }
}
