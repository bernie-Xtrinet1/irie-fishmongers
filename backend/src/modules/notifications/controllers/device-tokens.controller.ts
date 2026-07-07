import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RegisterDeviceTokenDto } from '../dto/register-device-token.dto';
import { DeviceTokensService } from '../services/device-tokens.service';

@ApiTags('device-tokens')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications/device-tokens')
export class DeviceTokensController {
  constructor(private readonly deviceTokensService: DeviceTokensService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register a push notification device token for the authenticated user' })
  @ApiResponseDoc({ status: 204 })
  async register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<void> {
    await this.deviceTokensService.register(user.id, dto.token, dto.platform);
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a device token (e.g. on logout/uninstall)" })
  @ApiResponseDoc({ status: 204 })
  async remove(@CurrentUser() user: RequestUser, @Param('token') token: string): Promise<void> {
    await this.deviceTokensService.remove(user.id, token);
  }
}
