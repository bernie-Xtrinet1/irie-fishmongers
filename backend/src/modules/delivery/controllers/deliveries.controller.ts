import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { AssignDeliveryDto } from '../dto/assign-delivery.dto';
import { UpdateDeliveryStatusDto } from '../dto/update-delivery-status.dto';
import { DeliveryTrackingEntity } from '../entities/delivery-tracking.entity';
import { DriverDeliveryResponseEntity } from '../entities/driver-delivery-response.entity';
import { PaginatedAvailableDeliveriesEntity } from '../entities/paginated-available-deliveries.entity';
import { PaginatedDriverDeliveriesEntity } from '../entities/paginated-driver-deliveries.entity';
import { DeliveriesService } from '../services/deliveries.service';

@ApiTags('delivery')
@Controller('delivery')
export class DeliveriesController {
  constructor(private readonly deliveriesService: DeliveriesService) {}

  @Get('available')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List vendor orders ready for pickup and not yet claimed' })
  @ApiResponseDoc({ status: 200, type: PaginatedAvailableDeliveriesEntity })
  getAvailable(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedAvailableDeliveriesEntity> {
    return this.deliveriesService.getAvailable(user.id, dto);
  }

  @Post('assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Claim an available vendor order for delivery' })
  @ApiResponseDoc({ status: 201, type: DriverDeliveryResponseEntity })
  assign(
    @CurrentUser() user: RequestUser,
    @Body() dto: AssignDeliveryDto,
  ): Promise<DriverDeliveryResponseEntity> {
    return this.deliveriesService.assign(user.id, dto);
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the authenticated driver's deliveries" })
  @ApiResponseDoc({ status: 200, type: PaginatedDriverDeliveriesEntity })
  getMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedDriverDeliveriesEntity> {
    return this.deliveriesService.getMine(user.id, dto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Advance an owned delivery to picked up, delivered, or failed' })
  @ApiResponseDoc({ status: 200, type: DriverDeliveryResponseEntity })
  updateStatus(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
  ): Promise<DriverDeliveryResponseEntity> {
    return this.deliveriesService.updateStatus(user.id, id, dto);
  }

  @Get('track/:vendorOrderId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Track the delivery for a vendor portion of an owned order' })
  @ApiResponseDoc({ status: 200, type: DeliveryTrackingEntity })
  track(
    @CurrentUser() user: RequestUser,
    @Param('vendorOrderId') vendorOrderId: string,
  ): Promise<DeliveryTrackingEntity> {
    return this.deliveriesService.track(user.id, vendorOrderId);
  }
}
