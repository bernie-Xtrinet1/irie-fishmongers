import { ApiProperty } from '@nestjs/swagger';

import { DriverSettlementResponseEntity } from './driver-settlement-response.entity';

export class PaginatedDriverSettlementsEntity {
  @ApiProperty({ type: DriverSettlementResponseEntity, isArray: true })
  items!: DriverSettlementResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
