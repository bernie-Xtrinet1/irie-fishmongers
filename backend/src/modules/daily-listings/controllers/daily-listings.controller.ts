import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';
import { PaginatedAvailableTodayEntity } from '../entities/available-today-item.entity';
import { DailyListingResponseEntity } from '../entities/daily-listing-response.entity';
import { PaginatedDailyListingsEntity } from '../entities/paginated-daily-listings.entity';
import { DailyListingsService } from '../services/daily-listings.service';

@ApiTags('daily-listings')
@Controller('daily-listings')
export class DailyListingsController {
  constructor(private readonly dailyListingsService: DailyListingsService) {}

  @Get()
  @ApiOperation({ summary: 'Discover active, published, non-expired seafood listings (Available Today)' })
  @ApiResponseDoc({ status: 200, type: PaginatedDailyListingsEntity })
  findActiveListings(
    @Query() query: QueryDailyListingsDto,
  ): Promise<PaginatedDailyListingsEntity> {
    return this.dailyListingsService.findMany({
      ...query,
      activeOnly: true,
    });
  }

  @Get('available-today')
  @ApiOperation({ summary: 'Discover Available-Today marketplace catalogue items aggregated across vendors' })
  @ApiResponseDoc({ status: 200, type: PaginatedAvailableTodayEntity })
  getAvailableToday(
    @Query() query: QueryDailyListingsDto,
  ): Promise<PaginatedAvailableTodayEntity> {
    return this.dailyListingsService.getAvailableTodayMarketplace(query);
  }

  @Get('catalogue-item/:catalogueItemId')
  @ApiOperation({ summary: 'Get all active listings under a master seafood catalogue item' })
  @ApiResponseDoc({ status: 200, type: [DailyListingResponseEntity] })
  findByCatalogueItem(
    @Param('catalogueItemId') catalogueItemId: string,
  ): Promise<DailyListingResponseEntity[]> {
    return this.dailyListingsService.findActiveByCatalogueItemId(catalogueItemId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get public details for a daily seafood listing (fail-closed if not currently available)' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  findOne(
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.findPublicById(id);
  }
}
