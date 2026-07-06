import { ApiProperty } from '@nestjs/swagger';

import { SeafoodLotResponseEntity } from './seafood-lot-response.entity';

export class PaginatedSeafoodLotsEntity {
  @ApiProperty({ type: SeafoodLotResponseEntity, isArray: true })
  items!: SeafoodLotResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
