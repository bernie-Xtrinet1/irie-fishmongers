import { ApiProperty } from '@nestjs/swagger';

import { VendorDowngradeEventResponseEntity } from './vendor-downgrade-event-response.entity';

export class PaginatedDowngradeEventsEntity {
  @ApiProperty({ type: VendorDowngradeEventResponseEntity, isArray: true })
  items!: VendorDowngradeEventResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
