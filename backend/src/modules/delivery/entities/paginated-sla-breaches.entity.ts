import { ApiProperty } from '@nestjs/swagger';

import { SLABreachResponseEntity } from './sla-breach-response.entity';

export class PaginatedSLABreachesEntity {
  @ApiProperty({ type: SLABreachResponseEntity, isArray: true })
  items!: SLABreachResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
