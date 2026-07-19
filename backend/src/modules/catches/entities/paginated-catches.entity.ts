import { ApiProperty } from '@nestjs/swagger';

import { CatchResponseEntity } from './catch-response.entity';

export class PaginatedCatchesEntity {
  @ApiProperty({ type: CatchResponseEntity, isArray: true })
  items!: CatchResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
