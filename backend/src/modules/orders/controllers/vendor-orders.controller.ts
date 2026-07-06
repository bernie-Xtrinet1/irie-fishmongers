import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
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
import { ListVendorOrdersDto } from '../dto/list-vendor-orders.dto';
import { PaginatedVendorOrdersEntity } from '../entities/paginated-vendor-orders.entity';
import { VendorOrderResponseEntity } from '../entities/vendor-order-response.entity';
import { VendorOrdersService } from '../services/vendor-orders.service';

@ApiTags('vendor-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.VENDOR)
@Controller('vendor-orders')
export class VendorOrdersController {
  constructor(private readonly vendorOrdersService: VendorOrdersService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated vendor's incoming orders" })
  @ApiResponseDoc({ status: 200, type: PaginatedVendorOrdersEntity })
  list(
    @CurrentUser() user: RequestUser,
    @Query() dto: ListVendorOrdersDto,
  ): Promise<PaginatedVendorOrdersEntity> {
    return this.vendorOrdersService.getIncomingOrders(user.id, dto.status, dto);
  }

  @Patch(':id/accept')
  @ApiOperation({ summary: 'Accept a pending vendor order' })
  @ApiResponseDoc({ status: 200, type: VendorOrderResponseEntity })
  accept(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<VendorOrderResponseEntity> {
    return this.vendorOrdersService.accept(user.id, id);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a pending vendor order, restoring reserved stock' })
  @ApiResponseDoc({ status: 200, type: VendorOrderResponseEntity })
  reject(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<VendorOrderResponseEntity> {
    return this.vendorOrdersService.reject(user.id, id);
  }

  @Patch(':id/preparing')
  @ApiOperation({ summary: 'Mark an accepted vendor order as being prepared' })
  @ApiResponseDoc({ status: 200, type: VendorOrderResponseEntity })
  markPreparing(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<VendorOrderResponseEntity> {
    return this.vendorOrdersService.markPreparing(user.id, id);
  }

  @Patch(':id/ready')
  @ApiOperation({ summary: 'Mark a prepared vendor order as ready for driver pickup' })
  @ApiResponseDoc({ status: 200, type: VendorOrderResponseEntity })
  markReadyForPickup(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<VendorOrderResponseEntity> {
    return this.vendorOrdersService.markReadyForPickup(user.id, id);
  }
}
