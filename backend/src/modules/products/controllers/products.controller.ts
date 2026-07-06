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
import { AdjustStockDto } from '../dto/adjust-stock.dto';
import { CreateProductDto } from '../dto/create-product.dto';
import { SearchProductsDto } from '../dto/search-products.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { PaginatedProductsEntity } from '../entities/paginated-products.entity';
import { ProductResponseEntity } from '../entities/product-response.entity';
import { ProductsService } from '../services/products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product listing for the authenticated (approved) vendor' })
  @ApiResponseDoc({ status: 201, type: ProductResponseEntity })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateProductDto,
  ): Promise<ProductResponseEntity> {
    return this.productsService.create(user.id, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a product owned by the authenticated vendor' })
  @ApiResponseDoc({ status: 200, type: ProductResponseEntity })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductResponseEntity> {
    return this.productsService.update(user.id, id, dto);
  }

  @Patch(':id/stock')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Adjust available stock for a product owned by the vendor' })
  @ApiResponseDoc({ status: 200, type: ProductResponseEntity })
  adjustStock(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: AdjustStockDto,
  ): Promise<ProductResponseEntity> {
    return this.productsService.adjustStock(user.id, id, dto.delta);
  }

  @Patch(':id/deactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a product from public listing without deleting it' })
  @ApiResponseDoc({ status: 200, type: ProductResponseEntity })
  deactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<ProductResponseEntity> {
    return this.productsService.setActive(user.id, id, false);
  }

  @Patch(':id/reactivate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.VENDOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Restore a previously deactivated product to public listing' })
  @ApiResponseDoc({ status: 200, type: ProductResponseEntity })
  reactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<ProductResponseEntity> {
    return this.productsService.setActive(user.id, id, true);
  }

  @Get()
  @ApiOperation({ summary: 'Search and filter the public product catalog' })
  @ApiResponseDoc({ status: 200, type: PaginatedProductsEntity })
  search(@Query() dto: SearchProductsDto): Promise<PaginatedProductsEntity> {
    return this.productsService.search(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single active product by id' })
  @ApiResponseDoc({ status: 200, type: ProductResponseEntity })
  findById(@Param('id') id: string): Promise<ProductResponseEntity> {
    return this.productsService.findPublicById(id);
  }
}
