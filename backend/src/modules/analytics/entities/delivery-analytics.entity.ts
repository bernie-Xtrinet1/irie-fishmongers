import { ApiProperty } from '@nestjs/swagger';
import { CustomerAcceptanceStatus, FleetAssetStatus } from '@prisma/client';

export class ZoneBreachSummaryEntity {
  @ApiProperty()
  zoneId!: string;

  @ApiProperty()
  totalBreaches!: number;

  @ApiProperty()
  unresolvedBreaches!: number;
}

export class FleetZoneSummaryEntity {
  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ enum: FleetAssetStatus })
  status!: FleetAssetStatus;

  @ApiProperty()
  count!: number;
}

class DeliveryAcceptanceCountsEntity implements Record<CustomerAcceptanceStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  ACCEPTED!: number;

  @ApiProperty()
  REJECTED!: number;
}

export class DeliveryAnalyticsEntity {
  @ApiProperty({
    type: ZoneBreachSummaryEntity,
    isArray: true,
    description: 'Point-in-time snapshot - ignores the from/to range',
  })
  slaBreachesByZone!: ZoneBreachSummaryEntity[];

  @ApiProperty({ description: 'sum(unresolvedBreaches) across all zones - point-in-time snapshot' })
  totalUnresolvedBreaches!: number;

  @ApiProperty({
    type: FleetZoneSummaryEntity,
    isArray: true,
    description: 'Point-in-time snapshot - ignores the from/to range',
  })
  fleetByZone!: FleetZoneSummaryEntity[];

  @ApiProperty({ type: DeliveryAcceptanceCountsEntity })
  byCustomerAcceptanceStatus!: DeliveryAcceptanceCountsEntity;
}
