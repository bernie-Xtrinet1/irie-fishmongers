import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

export class FleetTripResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fleetAssetId!: string;

  @ApiProperty()
  driverId!: string;

  @ApiProperty()
  zoneId!: string;

  @ApiProperty()
  startedAt!: Date;

  @ApiProperty({ required: false, nullable: true })
  endedAt!: Date | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  fuelCost!: Prisma.Decimal | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  driverWage!: Prisma.Decimal | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  maintenanceAllocation!: Prisma.Decimal | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  insuranceAllocation!: Prisma.Decimal | null;

  @ApiProperty()
  createdAt!: Date;
}
