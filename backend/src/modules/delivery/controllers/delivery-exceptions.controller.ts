import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
import { CreateDeliveryExceptionDto } from '../dto/create-delivery-exception.dto';
import { ListDeliveryExceptionsDto } from '../dto/list-delivery-exceptions.dto';
import { DeliveryExceptionResponseEntity } from '../entities/delivery-exception-response.entity';
import { PaginatedDeliveryExceptionsWithContextEntity } from '../entities/paginated-delivery-exceptions-with-context.entity';
import { DeliveryExceptionsService } from '../services/delivery-exceptions.service';

@ApiTags('delivery')
@Controller('delivery')
export class DeliveryExceptionsController {
  constructor(private readonly deliveryExceptionsService: DeliveryExceptionsService) {}

  @Post(':id/exceptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report a delivery exception for an owned, still-open delivery' })
  @ApiResponseDoc({ status: 201, type: DeliveryExceptionResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: CreateDeliveryExceptionDto,
  ): Promise<DeliveryExceptionResponseEntity> {
    return this.deliveryExceptionsService.create(user.id, id, dto);
  }

  @Get('exceptions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List delivery exceptions with vendor/customer/driver context, optionally filtered by resolution status (admin only)',
  })
  @ApiResponseDoc({ status: 200, type: PaginatedDeliveryExceptionsWithContextEntity })
  list(
    @Query() dto: ListDeliveryExceptionsDto,
  ): Promise<PaginatedDeliveryExceptionsWithContextEntity> {
    return this.deliveryExceptionsService.list(dto);
  }

  @Patch('exceptions/:id/resolve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark a delivery exception resolved (admin only)' })
  @ApiResponseDoc({ status: 200, type: DeliveryExceptionResponseEntity })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<DeliveryExceptionResponseEntity> {
    return this.deliveryExceptionsService.resolve(id, user.id);
  }
}
