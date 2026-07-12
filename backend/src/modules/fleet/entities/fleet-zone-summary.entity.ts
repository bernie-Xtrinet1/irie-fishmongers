import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetStatus } from '@prisma/client';

// 10D fleet/zone rollup - one row per (zone, status) combination actually
// present in the fleet_assets table, not a dense cross-product. A zone
// with zero RETIRED assets simply has no RETIRED row here.
export class FleetZoneSummaryEntity {
  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ enum: FleetAssetStatus })
  status!: FleetAssetStatus;

  @ApiProperty()
  count!: number;
}
