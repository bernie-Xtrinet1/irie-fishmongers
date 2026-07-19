import { ApiProperty } from '@nestjs/swagger';

import { VesselResponseEntity } from './vessel-response.entity';

export class PaginatedVesselsEntity {
  @ApiProperty({ type: VesselResponseEntity, isArray: true })
  items!: VesselResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
