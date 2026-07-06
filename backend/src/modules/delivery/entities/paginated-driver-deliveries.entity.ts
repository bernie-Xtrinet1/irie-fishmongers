import { ApiProperty } from '@nestjs/swagger';

import { DriverDeliveryResponseEntity } from './driver-delivery-response.entity';

export class PaginatedDriverDeliveriesEntity {
  @ApiProperty({ type: DriverDeliveryResponseEntity, isArray: true })
  items!: DriverDeliveryResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
