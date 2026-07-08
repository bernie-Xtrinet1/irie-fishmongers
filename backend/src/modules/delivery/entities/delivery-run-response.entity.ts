import { ApiProperty } from '@nestjs/swagger';
import { DeliveryRunStatus } from '@prisma/client';

export class DeliveryRunStopResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  deliveryId!: string;

  @ApiProperty()
  sequence!: number;
}

export class DeliveryRunResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ required: false, nullable: true })
  driverId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  fleetAssetId!: string | null;

  @ApiProperty({ enum: DeliveryRunStatus })
  status!: DeliveryRunStatus;

  @ApiProperty({ type: DeliveryRunStopResponseEntity, isArray: true })
  stops!: DeliveryRunStopResponseEntity[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
