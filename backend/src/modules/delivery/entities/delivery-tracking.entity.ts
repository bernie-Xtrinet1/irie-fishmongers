import { ApiProperty } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';

import { DeliveryStage, DELIVERY_STAGES } from './driver-delivery-response.entity';

export class DriverLocationEntity {
  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty()
  recordedAt!: Date;
}

export class DeliveryTrackingEntity {
  @ApiProperty()
  vendorOrderId!: string;

  @ApiProperty({ enum: DELIVERY_STAGES })
  stage!: DeliveryStage;

  @ApiProperty()
  driverFirstName!: string;

  @ApiProperty({ required: false, nullable: true })
  driverPhone!: string | null;

  @ApiProperty({ enum: VehicleType })
  driverVehicleType!: VehicleType;

  @ApiProperty()
  driverLicensePlate!: string;

  @ApiProperty({ type: DriverLocationEntity, required: false, nullable: true })
  latestLocation!: DriverLocationEntity | null;

  @ApiProperty()
  assignedAt!: Date;

  @ApiProperty({ required: false, nullable: true })
  pickedUpAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  deliveredAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  failedAt!: Date | null;
}
