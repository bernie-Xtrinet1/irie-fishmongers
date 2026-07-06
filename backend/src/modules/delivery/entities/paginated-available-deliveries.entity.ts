import { ApiProperty } from '@nestjs/swagger';

import { AvailableDeliveryEntity } from './available-delivery.entity';

export class PaginatedAvailableDeliveriesEntity {
  @ApiProperty({ type: AvailableDeliveryEntity, isArray: true })
  items!: AvailableDeliveryEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
