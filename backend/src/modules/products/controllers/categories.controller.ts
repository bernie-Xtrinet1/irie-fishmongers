import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse as ApiResponseDoc,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { CategoryResponseEntity } from '../entities/category-response.entity';
import { CategoriesService } from '../services/categories.service';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List all product categories' })
  @ApiResponseDoc({ status: 200, type: CategoryResponseEntity, isArray: true })
  findAll(): Promise<CategoryResponseEntity[]> {
    return this.categoriesService.findAll();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product category (admin only)' })
  @ApiResponseDoc({ status: 201, type: CategoryResponseEntity })
  create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseEntity> {
    return this.categoriesService.create(dto);
  }
}
