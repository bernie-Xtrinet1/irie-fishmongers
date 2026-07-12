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
import { Driver, RoleName } from '@prisma/client';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateDriverColdChainCertificationDto } from '../dto/create-driver-cold-chain-certification.dto';
import { ListDriversDto } from '../dto/list-drivers.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { RecordLocationDto } from '../dto/record-location.dto';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { UpdateDriverAvailabilityDto } from '../dto/update-driver-availability.dto';
import { UpdateDriverProfileDto } from '../dto/update-driver-profile.dto';
import { UpdateDriverStatusDto } from '../dto/update-driver-status.dto';
import { DriverColdChainCertificationResponseEntity } from '../entities/driver-cold-chain-certification-response.entity';
import { DriverPerformanceMetricsEntity } from '../entities/driver-performance-metrics.entity';
import { DriverResponseEntity } from '../entities/driver-response.entity';
import { PaginatedDriverColdChainCertificationsEntity } from '../entities/paginated-driver-cold-chain-certifications.entity';
import { PaginatedDriversEntity } from '../entities/paginated-drivers.entity';
import { DriverColdChainCertificationsService } from '../services/driver-cold-chain-certifications.service';
import { DriversService } from '../services/drivers.service';

@ApiTags('drivers')
@Controller('drivers')
export class DriversController {
  constructor(
    private readonly driversService: DriversService,
    private readonly driverColdChainCertificationsService: DriverColdChainCertificationsService,
  ) {}

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

  @Patch('me/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Go online or offline for delivery assignment' })
  @ApiResponseDoc({ status: 200, type: DriverResponseEntity })
  updateAvailability(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateDriverAvailabilityDto,
  ): Promise<Driver> {
    return this.driversService.updateAvailability(user.id, dto.status);
  }

  @Patch('me/profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update vehicle capacity and cold-chain capability for the authenticated driver' })
  @ApiResponseDoc({ status: 200, type: DriverResponseEntity })
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateDriverProfileDto,
  ): Promise<Driver> {
    return this.driversService.updateProfile(user.id, dto);
  }

  @Get('me/performance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated driver's computed performance metrics" })
  @ApiResponseDoc({ status: 200, type: DriverPerformanceMetricsEntity })
  getOwnPerformanceMetrics(
    @CurrentUser() user: RequestUser,
  ): Promise<DriverPerformanceMetricsEntity> {
    return this.driversService.getOwnPerformanceMetrics(user.id);
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

  @Get(':id/performance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a driver's computed performance metrics (admin only)" })
  @ApiResponseDoc({ status: 200, type: DriverPerformanceMetricsEntity })
  getPerformanceMetrics(@Param('id') id: string): Promise<DriverPerformanceMetricsEntity> {
    return this.driversService.getPerformanceMetrics(id);
  }

  @Post(':id/cold-chain-certifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: '10E: issue a cold-chain handling certification to a driver (admin only)' })
  @ApiResponseDoc({ status: 201, type: DriverColdChainCertificationResponseEntity })
  createColdChainCertification(
    @Param('id') id: string,
    @Body() dto: CreateDriverColdChainCertificationDto,
  ): Promise<DriverColdChainCertificationResponseEntity> {
    return this.driverColdChainCertificationsService.create(id, dto);
  }

  @Get(':id/cold-chain-certifications')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "10E: list a driver's cold-chain certifications (admin only)" })
  @ApiResponseDoc({ status: 200, type: PaginatedDriverColdChainCertificationsEntity })
  listColdChainCertifications(
    @Param('id') id: string,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedDriverColdChainCertificationsEntity> {
    return this.driverColdChainCertificationsService.findByDriverId(id, dto);
  }

  @Patch('cold-chain-certifications/:certificationId/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "10E: revoke a driver's cold-chain certification early (admin only)" })
  @ApiResponseDoc({ status: 200, type: DriverColdChainCertificationResponseEntity })
  revokeColdChainCertification(
    @Param('certificationId') certificationId: string,
  ): Promise<DriverColdChainCertificationResponseEntity> {
    return this.driverColdChainCertificationsService.revoke(certificationId);
  }
}
