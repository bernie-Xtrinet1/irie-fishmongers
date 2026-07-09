import { ApiProperty } from '@nestjs/swagger';

import { FishermanResponseEntity } from './fisherman-response.entity';

export class PaginatedFishermenEntity {
  @ApiProperty({ type: FishermanResponseEntity, isArray: true })
  items!: FishermanResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
