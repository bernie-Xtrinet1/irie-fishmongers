import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { QueryDailyListingsDto } from '../dto/query-daily-listings.dto';
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

  @Get(':id')
  @ApiOperation({ summary: 'Get public details for a daily seafood listing' })
  @ApiResponseDoc({ status: 200, type: DailyListingResponseEntity })
  findOne(
    @Param('id') id: string,
  ): Promise<DailyListingResponseEntity> {
    return this.dailyListingsService.findById(id, false);
  }

  @Get('catalogue-item/:catalogueItemId')
  @ApiOperation({ summary: 'Get all active listings under a master seafood catalogue item' })
  @ApiResponseDoc({ status: 200, type: [DailyListingResponseEntity] })
  findByCatalogueItem(
    @Param('catalogueItemId') catalogueItemId: string,
  ): Promise<DailyListingResponseEntity[]> {
    return this.dailyListingsService.findActiveByCatalogueItemId(catalogueItemId);
  }
}
