import { ApiProperty } from '@nestjs/swagger';

import { VendorResponseEntity } from './vendor-response.entity';

export class PaginatedVendorsEntity {
  @ApiProperty({ type: VendorResponseEntity, isArray: true })
  items!: VendorResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
