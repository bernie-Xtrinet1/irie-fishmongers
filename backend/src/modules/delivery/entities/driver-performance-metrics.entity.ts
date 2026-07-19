import { ApiProperty } from '@nestjs/swagger';

export class DriverPerformanceMetricsEntity {
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Delivered-on-time ratio (0-1) among deliveries with a customer delivery window set; null if none',
  })
  onTimeDeliveryRate!: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Average minutes between assignment and pickup; null if the driver has no picked-up deliveries',
  })
  averagePickupDelayMinutes!: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Accepted ratio (0-1) among deliveries with a resolved customer acceptance decision; null if none',
  })
  customerAcceptanceRate!: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Failed ratio (0-1) among delivered + failed deliveries; null if the driver has neither',
  })
  failedDeliveryRate!: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Ratio (0-1) of deliveries with a matched cold-chain temperature reading and no alert, among deliveries with any matched reading; null if none',
  })
  temperatureComplianceRate!: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Average delivery duration in minutes, from RouteHistory; null if none recorded yet',
  })
  averageDeliveryDurationMinutes!: number | null;
}
