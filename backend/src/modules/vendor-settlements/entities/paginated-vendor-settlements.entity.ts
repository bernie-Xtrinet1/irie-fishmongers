import { ApiProperty } from '@nestjs/swagger';

import { VendorSettlementResponseEntity } from './vendor-settlement-response.entity';

export class PaginatedVendorSettlementsEntity {
  @ApiProperty({ type: VendorSettlementResponseEntity, isArray: true })
  items!: VendorSettlementResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
