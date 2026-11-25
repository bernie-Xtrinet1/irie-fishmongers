import { ApiProperty } from '@nestjs/swagger';
import { TemperatureCheckpoint, TemperatureReadingOrigin } from '@prisma/client';

export class TemperatureReadingResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty({ required: false, nullable: true })
  deviceId!: string | null;

  @ApiProperty({ enum: TemperatureCheckpoint })
  checkpoint!: TemperatureCheckpoint;

  @ApiProperty()
  temperatureC!: string;

  @ApiProperty({ enum: TemperatureReadingOrigin, required: false })
  origin?: TemperatureReadingOrigin;

  @ApiProperty({ required: false, nullable: true })
  capturedAt?: Date | null;

  @ApiProperty({ required: false })
  receivedAt?: Date;

  @ApiProperty({ required: false })
  isDelayed?: boolean;

  @ApiProperty({ required: false, nullable: true })
  deliveryId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  fleetAssetId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  compartmentId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  trackerId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  telemetryFrameId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  recordedById?: string | null;

  @ApiProperty({ required: false, nullable: true })
  latitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  photoUrl!: string | null;

  @ApiProperty()
  recordedAt!: Date;
}
