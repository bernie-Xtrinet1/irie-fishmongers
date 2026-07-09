import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { RegisterTemperatureDeviceDto } from '../dto/register-temperature-device.dto';
import { TemperatureDeviceResponseEntity } from '../entities/temperature-device-response.entity';
import { TemperatureDevicesService } from '../services/temperature-devices.service';

@ApiTags('temperature-devices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('temperature-devices')
export class TemperatureDevicesController {
  constructor(private readonly devicesService: TemperatureDevicesService) {}

  @Post()
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: 'Register a temperature-logging device for the authenticated vendor' })
  @ApiResponseDoc({ status: 201, type: TemperatureDeviceResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterTemperatureDeviceDto,
  ): Promise<TemperatureDeviceResponseEntity> {
    return this.devicesService.register(user.id, dto);
  }

  @Get('mine')
  @Roles(RoleName.VENDOR)
  @ApiOperation({ summary: "List the authenticated vendor's devices" })
  @ApiResponseDoc({ status: 200, type: TemperatureDeviceResponseEntity, isArray: true })
  getMine(@CurrentUser() user: RequestUser): Promise<TemperatureDeviceResponseEntity[]> {
    return this.devicesService.getMine(user.id);
  }

  @Get()
  @Roles(RoleName.ADMINISTRATOR)
  @ApiOperation({ summary: 'List devices, optionally filtered by vendor, flagging offline devices (admin only)' })
  @ApiResponseDoc({ status: 200, type: TemperatureDeviceResponseEntity, isArray: true })
  list(@Query('vendorId') vendorId?: string): Promise<TemperatureDeviceResponseEntity[]> {
    return this.devicesService.list(vendorId);
  }
}
