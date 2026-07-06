import { ApiProperty } from '@nestjs/swagger';

import { RecallResponseEntity } from './recall-response.entity';

export class PaginatedRecallsEntity {
  @ApiProperty({ type: RecallResponseEntity, isArray: true })
  items!: RecallResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
