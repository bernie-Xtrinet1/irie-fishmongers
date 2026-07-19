import { ApiProperty } from '@nestjs/swagger';

import { DeliveryRunResponseEntity } from './delivery-run-response.entity';

export class PaginatedDeliveryRunsEntity {
  @ApiProperty({ type: DeliveryRunResponseEntity, isArray: true })
  items!: DeliveryRunResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
