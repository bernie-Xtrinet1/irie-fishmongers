import { ApiProperty } from '@nestjs/swagger';

export class RouteStopEntity {
  @ApiProperty()
  deliveryId!: string;

  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty()
  zoneId!: string;
}

export class RoutePlanResponseEntity {
  @ApiProperty()
  strategyName!: string;

  @ApiProperty({ type: RouteStopEntity, isArray: true })
  orderedStops!: RouteStopEntity[];

  @ApiProperty({ description: 'Audit-trail record id for this planning decision' })
  routeOptimizationRunId!: string;

  @ApiProperty({ description: 'The DeliveryRun persisted for dispatch to act on' })
  deliveryRunId!: string;
}
