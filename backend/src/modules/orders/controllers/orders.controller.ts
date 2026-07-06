import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { CheckoutDto } from '../dto/checkout.dto';
import { OrderResponseEntity } from '../entities/order-response.entity';
import { PaginatedOrdersEntity } from '../entities/paginated-orders.entity';
import { OrdersService } from '../services/orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.CUSTOMER)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @ApiOperation({ summary: 'Convert the current cart into an order' })
  @ApiResponseDoc({ status: 201, type: OrderResponseEntity })
  checkout(
    @CurrentUser() user: RequestUser,
    @Body() dto: CheckoutDto,
  ): Promise<OrderResponseEntity> {
    return this.ordersService.checkout(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the authenticated customer's orders" })
  @ApiResponseDoc({ status: 200, type: PaginatedOrdersEntity })
  list(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedOrdersEntity> {
    return this.ordersService.getCustomerOrders(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order owned by the authenticated customer' })
  @ApiResponseDoc({ status: 200, type: OrderResponseEntity })
  findById(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<OrderResponseEntity> {
    return this.ordersService.getCustomerOrderById(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel every still-pending part of an order' })
  @ApiResponseDoc({ status: 200, type: OrderResponseEntity })
  cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<OrderResponseEntity> {
    return this.ordersService.cancelOrder(user.id, id);
  }

  @Post(':id/vendor-orders/:vendorOrderId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a single vendor portion of an order while still pending' })
  @ApiResponseDoc({ status: 200, type: OrderResponseEntity })
  cancelVendorOrder(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('vendorOrderId') vendorOrderId: string,
  ): Promise<OrderResponseEntity> {
    return this.ordersService.cancelVendorOrder(user.id, id, vendorOrderId);
  }
}
