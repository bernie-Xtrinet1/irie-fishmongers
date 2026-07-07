import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { UpdatePreferencesDto } from '../dto/update-preferences.dto';
import { PreferenceResponseEntity } from '../entities/preference-response.entity';
import { NotificationPreferencesService } from '../services/notification-preferences.service';

@ApiTags('notification-preferences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications/preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferencesService: NotificationPreferencesService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's notification preferences" })
  @ApiResponseDoc({ status: 200, type: PreferenceResponseEntity })
  getMine(@CurrentUser() user: RequestUser): Promise<PreferenceResponseEntity> {
    return this.preferencesService.getMine(user.id);
  }

  @Patch()
  @ApiOperation({ summary: "Update the authenticated user's notification preferences" })
  @ApiResponseDoc({ status: 200, type: PreferenceResponseEntity })
  updateMine(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<PreferenceResponseEntity> {
    return this.preferencesService.updateMine(user.id, dto);
  }
}
