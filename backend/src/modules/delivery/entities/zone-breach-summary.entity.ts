import { ApiProperty } from '@nestjs/swagger';

// 10D fleet/zone rollup - one row per zone that has at least one recorded
// SLA breach. A zone with zero breaches simply has no row here.
export class ZoneBreachSummaryEntity {
  @ApiProperty()
  zoneId!: string;

  @ApiProperty()
  totalBreaches!: number;

  @ApiProperty()
  unresolvedBreaches!: number;
}
