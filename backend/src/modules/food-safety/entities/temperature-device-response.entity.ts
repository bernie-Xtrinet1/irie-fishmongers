import { ApiProperty } from '@nestjs/swagger';
import { DeviceStatus } from '@prisma/client';

export class TemperatureDeviceResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  vendorId!: string;

  @ApiProperty()
  deviceCode!: string;

  @ApiProperty({ enum: DeviceStatus })
  status!: DeviceStatus;

  @ApiProperty({ required: false, nullable: true })
  lastSeenAt!: Date | null;

  @ApiProperty({ description: 'Computed on read: true when no reading has been seen within the staleness window' })
  isOffline!: boolean;

  @ApiProperty({ required: false, nullable: true })
  lastCalibratedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  calibrationDueAt!: Date | null;

  @ApiProperty({
    description:
      'Computed on read, informational only - does not block reading ingestion. True when calibrationDueAt has passed.',
  })
  isCalibrationOverdue!: boolean;

  @ApiProperty()
  createdAt!: Date;
}
