import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
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
import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';
import { SuspendDailyListingDto } from '../dto/suspend-daily-listing.dto';
import { DailyListingResponseEntity } from '../entities/daily-listing-response.entity';
import { PaginatedDailyListingsEntity } from '../entities/paginated-daily-listings.entity';
import { DailyListingsService } from '../services/daily-listings.service';

@ApiTags('admin/daily-listings')
@Controller('admin/daily-listings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMINISTRATOR, RoleName.OPERATIONS_STAFF)
@ApiBearerAuth()
export class AdminDailyListingsController {
  constructor(private readonly dailyListingsService: DailyListingsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin/compliance listing audit and inspection across all vendors and states' })
  @ApiResponseDoc({ status: 200, type: PaginatedDailyListingsEntity })
  findAll(
    @Query() query: QueryDailyListingsDto,
  ): Promise<PaginatedDailyListingsEntity> {
    return this.dailyListingsService.findMany(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin inspection of a daily listing (includes withdrawn photos and audit fields)' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  findOne(
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.findById(id, true);
  }

  @Post(':id/suspend')
  @ApiOperation({ summary: 'Administratively suspend a daily listing for regulatory or inspection cause' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  suspend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: SuspendDailyListingDto,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.suspend(user.id, id, dto);
  }

  @Post(':id/reinstate')
  @ApiOperation({ summary: 'Reinstate an administratively suspended listing after regulatory verification' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  reinstate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.reinstate(user.id, id);
  }
}
