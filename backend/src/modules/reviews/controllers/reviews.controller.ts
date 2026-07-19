import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { CreateReviewDto } from '../dto/create-review.dto';
import { ListReviewsDto } from '../dto/list-reviews.dto';
import { UpdateReviewDto } from '../dto/update-review.dto';
import { PaginatedReviewsEntity } from '../entities/paginated-reviews.entity';
import { ReviewEligibilityEntity } from '../entities/review-eligibility.entity';
import { ReviewResponseEntity } from '../entities/review-response.entity';
import { ReviewsService } from '../services/reviews.service';

@ApiTags('reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Write a review for a delivered order (vendor and/or product) - customer only' })
  @ApiResponseDoc({ status: 201, type: ReviewResponseEntity })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateReviewDto): Promise<ReviewResponseEntity> {
    return this.reviewsService.create(user.id, dto);
  }

  @Get('eligibility')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @ApiOperation({ summary: 'Check whether the customer may review a given order/product - customer only' })
  @ApiResponseDoc({ status: 200, type: ReviewEligibilityEntity })
  checkEligibility(
    @CurrentUser() user: RequestUser,
    @Query('vendorOrderId', new ParseUUIDPipe()) vendorOrderId: string,
    @Query('productId') productId?: string,
  ): Promise<ReviewEligibilityEntity> {
    return this.reviewsService.checkEligibility(user.id, vendorOrderId, productId);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Edit your own review within the edit window - customer only' })
  @ApiResponseDoc({ status: 200, type: ReviewResponseEntity })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateReviewDto,
  ): Promise<ReviewResponseEntity> {
    return this.reviewsService.update(user.id, id, dto);
  }

  @Patch(':id/restore')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @ApiOperation({ summary: 'Restore your own author-removed review within the edit window - customer only' })
  @ApiResponseDoc({ status: 200, type: ReviewResponseEntity })
  restore(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReviewResponseEntity> {
    return this.reviewsService.restore(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleName.CUSTOMER)
  @ApiOperation({ summary: 'Remove your own review from public view (soft delete) - customer only' })
  @ApiResponseDoc({ status: 204 })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.reviewsService.softDelete(user.id, id);
  }

  @Get('vendor/:vendorId')
  @ApiOperation({ summary: 'Public list of a vendor\'s visible reviews, newest first' })
  @ApiResponseDoc({ status: 200, type: PaginatedReviewsEntity })
  listByVendor(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Query() dto: ListReviewsDto,
  ): Promise<PaginatedReviewsEntity> {
    return this.reviewsService.listByVendor(vendorId, dto);
  }

  @Get('product/:productId')
  @ApiOperation({ summary: 'Public list of a product\'s visible reviews, newest first' })
  @ApiResponseDoc({ status: 200, type: PaginatedReviewsEntity })
  listByProduct(
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query() dto: ListReviewsDto,
  ): Promise<PaginatedReviewsEntity> {
    return this.reviewsService.listByProduct(productId, dto);
  }
}
