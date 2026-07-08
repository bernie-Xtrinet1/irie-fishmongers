import { ApiProperty } from '@nestjs/swagger';

import { FleetAssetResponseEntity } from './fleet-asset-response.entity';

export class PaginatedFleetAssetsEntity {
  @ApiProperty({ type: FleetAssetResponseEntity, isArray: true })
  items!: FleetAssetResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
