import { ApiProperty } from '@nestjs/swagger';
import { DeviceStatus, TelemetryGapKind, TemperatureSensorModel } from '@prisma/client';

import type { TelemetryReportingStatus } from '../../telemetry/telemetry-status.util';

export class TemperatureDeviceResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  vendorId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  compartmentId?: string | null;

  @ApiProperty()
  deviceCode!: string;

  @ApiProperty({ enum: TemperatureSensorModel, required: false })
  hardwareModel?: TemperatureSensorModel;

  @ApiProperty({ required: false, nullable: true })
  bleMacAddress?: string | null;

  @ApiProperty({ required: false, nullable: true })
  sensorSlot?: number | null;

  @ApiProperty({ required: false, nullable: true })
  firmwareVersion?: string | null;

  @ApiProperty({ enum: DeviceStatus })
  status!: DeviceStatus;

  @ApiProperty({ required: false, nullable: true })
  lastSeenAt!: Date | null;

  @ApiProperty({ description: 'Computed on read: true when no reading has been seen within the staleness window' })
  isOffline!: boolean;

  @ApiProperty({ required: false, nullable: true })
  lastTemperatureC?: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastCapturedAt?: Date | null;

  @ApiProperty({ required: false, nullable: true })
  lastReceivedAt?: Date | null;

  @ApiProperty({ required: false, nullable: true })
  lastDelaySeconds?: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastHumidityPct?: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastBatteryMv?: number | null;

  @ApiProperty({ required: false, nullable: true })
  lastDoorOpen?: boolean | null;

  @ApiProperty({ required: false, nullable: true })
  lastMovement?: boolean | null;

  @ApiProperty({ enum: TelemetryGapKind, required: false, nullable: true })
  lastGapKind?: TelemetryGapKind | null;

  @ApiProperty({ required: false, nullable: true })
  lastSignalMissingAt?: Date | null;

  @ApiProperty({ required: false })
  reportingStatus?: TelemetryReportingStatus;

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
