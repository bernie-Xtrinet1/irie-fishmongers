import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListDriversDto } from '../dto/list-drivers.dto';
import { RecordLocationDto } from '../dto/record-location.dto';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { UpdateDriverStatusDto } from '../dto/update-driver-status.dto';
import { DriverResponseEntity } from '../entities/driver-response.entity';
import { PaginatedDriversEntity } from '../entities/paginated-drivers.entity';
import { DriversService } from '../services/drivers.service';

@ApiTags('drivers')
@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a driver profile for the authenticated account' })
  @ApiResponseDoc({ status: 201, type: DriverResponseEntity })
  register(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterDriverDto,
  ): Promise<DriverResponseEntity> {
    return this.driversService.register(user.id, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user's driver profile" })
  @ApiResponseDoc({ status: 200, type: DriverResponseEntity })
  getOwnProfile(@CurrentUser() user: RequestUser): Promise<DriverResponseEntity> {
    return this.driversService.getOwnProfile(user.id);
  }

  @Post('me/location')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report the authenticated driver current GPS location' })
  @ApiResponseDoc({ status: 204 })
  async recordLocation(
    @CurrentUser() user: RequestUser,
    @Body() dto: RecordLocationDto,
  ): Promise<void> {
    await this.driversService.recordLocation(user.id, dto.latitude, dto.longitude);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List drivers, optionally filtered by status (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedDriversEntity })
  list(@Query() dto: ListDriversDto): Promise<PaginatedDriversEntity> {
    return this.driversService.list(dto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve, suspend, or reject a driver (admin only)' })
  @ApiResponseDoc({ status: 200, type: DriverResponseEntity })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDriverStatusDto,
  ): Promise<DriverResponseEntity> {
    return this.driversService.updateStatus(id, dto.status);
  }
}
