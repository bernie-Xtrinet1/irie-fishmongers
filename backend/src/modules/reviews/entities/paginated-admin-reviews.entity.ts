import { ApiProperty } from '@nestjs/swagger';

import { AdminReviewEntity } from './admin-review.entity';

export class PaginatedAdminReviewsEntity {
  @ApiProperty({ type: AdminReviewEntity, isArray: true })
  items!: AdminReviewEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
