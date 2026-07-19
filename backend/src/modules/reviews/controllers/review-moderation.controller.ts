import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Request } from 'express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ListAdminReviewsDto } from '../dto/list-admin-reviews.dto';
import { RemoveReviewDto } from '../dto/remove-review.dto';
import { AdminReviewDetailEntity } from '../entities/admin-review-detail.entity';
import { AdminReviewEntity } from '../entities/admin-review.entity';
import { PaginatedAdminReviewsEntity } from '../entities/paginated-admin-reviews.entity';
import { ReviewModerationService } from '../services/review-moderation.service';

@ApiTags('admin-reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR)
@Controller('admin/reviews')
export class ReviewModerationController {
  constructor(private readonly moderationService: ReviewModerationService) {}

  @Get()
  @ApiOperation({ summary: 'List reviews for moderation, filterable by state/vendor/product/rating (admin only)' })
  @ApiResponseDoc({ status: 200, type: PaginatedAdminReviewsEntity })
  list(@Query() dto: ListAdminReviewsDto): Promise<PaginatedAdminReviewsEntity> {
    return this.moderationService.list(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a review with its full moderation audit trail (admin only)' })
  @ApiResponseDoc({ status: 200, type: AdminReviewDetailEntity })
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminReviewDetailEntity> {
    return this.moderationService.getById(id);
  }

  @Post(':id/remove')
  @ApiOperation({ summary: 'Remove a review from public view with a required reason (admin only)' })
  @ApiResponseDoc({ status: 201, type: AdminReviewEntity })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RemoveReviewDto,
    @Req() req: Request,
  ): Promise<AdminReviewEntity> {
    return this.moderationService.remove(user.id, id, dto, req.ip);
  }
}
