import { ApiProperty } from '@nestjs/swagger';

import { VendorUpgradeRequestResponseEntity } from './vendor-upgrade-request-response.entity';

export class PaginatedUpgradeRequestsEntity {
  @ApiProperty({ type: VendorUpgradeRequestResponseEntity, isArray: true })
  items!: VendorUpgradeRequestResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
