import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetStatus, FleetAssetType, FleetOwnership, Prisma } from '@prisma/client';

export class FleetAssetResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ enum: FleetAssetType })
  assetType!: FleetAssetType;

  @ApiProperty({ enum: FleetOwnership })
  ownership!: FleetOwnership;

  @ApiProperty()
  licensePlate!: string;

  @ApiProperty({ type: String })
  capacityLbs!: Prisma.Decimal;

  @ApiProperty()
  coldChainCapable!: boolean;

  @ApiProperty({ enum: FleetAssetStatus })
  status!: FleetAssetStatus;

  @ApiProperty({ required: false, nullable: true })
  currentDriverId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  lastLatitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastLongitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastSpeedKph!: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastHeadingDeg!: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastSatellites!: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastGpsCapturedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  lastTelemetryReceivedAt!: Date | null;

  @ApiProperty({ required: false })
  lastTelemetryDelayed!: boolean;

  @ApiProperty({ required: false, nullable: true })
  lastGpsNoFixAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
