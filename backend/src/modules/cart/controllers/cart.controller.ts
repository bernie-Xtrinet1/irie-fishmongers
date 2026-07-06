import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
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
import { AddCartItemDto } from '../dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../dto/update-cart-item.dto';
import { CartResponseEntity } from '../entities/cart-response.entity';
import { CartService } from '../services/cart.service';

@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.CUSTOMER)
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated customer's cart" })
  @ApiResponseDoc({ status: 200, type: CartResponseEntity })
  getCart(@CurrentUser() user: RequestUser): Promise<CartResponseEntity> {
    return this.cartService.getCart(user.id);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a product to the cart (or increase its quantity)' })
  @ApiResponseDoc({ status: 201, type: CartResponseEntity })
  addItem(
    @CurrentUser() user: RequestUser,
    @Body() dto: AddCartItemDto,
  ): Promise<CartResponseEntity> {
    return this.cartService.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Set the quantity of a cart item' })
  @ApiResponseDoc({ status: 200, type: CartResponseEntity })
  updateItemQuantity(
    @CurrentUser() user: RequestUser,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartResponseEntity> {
    return this.cartService.updateItemQuantity(user.id, itemId, dto);
  }

  @Delete('items/:itemId')
  @ApiOperation({ summary: 'Remove an item from the cart' })
  @ApiResponseDoc({ status: 200, type: CartResponseEntity })
  removeItem(
    @CurrentUser() user: RequestUser,
    @Param('itemId') itemId: string,
  ): Promise<CartResponseEntity> {
    return this.cartService.removeItem(user.id, itemId);
  }
}
