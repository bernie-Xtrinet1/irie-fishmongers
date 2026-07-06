import { ApiProperty } from '@nestjs/swagger';

import { DriverResponseEntity } from './driver-response.entity';

export class PaginatedDriversEntity {
  @ApiProperty({ type: DriverResponseEntity, isArray: true })
  items!: DriverResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
