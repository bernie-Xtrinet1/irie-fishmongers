import { ApiProperty } from '@nestjs/swagger';

import { VendorOrderResponseEntity } from './vendor-order-response.entity';

export class PaginatedVendorOrdersEntity {
  @ApiProperty({ type: VendorOrderResponseEntity, isArray: true })
  items!: VendorOrderResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
