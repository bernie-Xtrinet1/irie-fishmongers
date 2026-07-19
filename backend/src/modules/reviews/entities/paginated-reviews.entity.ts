import { ApiProperty } from '@nestjs/swagger';

import { ReviewResponseEntity } from './review-response.entity';

export class PaginatedReviewsEntity {
  @ApiProperty({ type: ReviewResponseEntity, isArray: true })
  items!: ReviewResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({ description: 'Average rating (1 decimal) across visible reviews; null when there are none' })
  averageRating!: number | null;
}
