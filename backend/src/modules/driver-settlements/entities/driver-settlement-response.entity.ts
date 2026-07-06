import { ApiProperty } from '@nestjs/swagger';
import { SettlementStatus, VehicleOwnership } from '@prisma/client';

export class DriverSettlementResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  driverId!: string;

  @ApiProperty({ required: false, nullable: true })
  deliveryId!: string | null;

  @ApiProperty({ enum: VehicleOwnership })
  vehicleOwnership!: VehicleOwnership;

  @ApiProperty()
  baseFee!: string;

  @ApiProperty()
  distanceKm!: string;

  @ApiProperty()
  distanceFee!: string;

  @ApiProperty()
  heavyLoadBonus!: string;

  @ApiProperty()
  peakBonus!: string;

  @ApiProperty()
  volumeBonus!: string;

  @ApiProperty()
  totalPayout!: string;

  @ApiProperty({ enum: SettlementStatus })
  status!: SettlementStatus;

  @ApiProperty()
  settlementPeriodStart!: Date;

  @ApiProperty()
  settlementPeriodEnd!: Date;

  @ApiProperty({ required: false, nullable: true })
  payoutDate!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
