import { ApiProperty } from '@nestjs/swagger';

import { DailyListingResponseEntity } from './daily-listing-response.entity';

export class PaginatedDailyListingsEntity {
  @ApiProperty({ type: [DailyListingResponseEntity] })
  items: DailyListingResponseEntity[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 3 })
  totalPages: number;
}
