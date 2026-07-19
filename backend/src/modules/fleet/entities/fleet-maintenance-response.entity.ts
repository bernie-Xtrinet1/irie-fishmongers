import { ApiProperty } from '@nestjs/swagger';
import { FleetMaintenanceStatus, Prisma } from '@prisma/client';

export class FleetMaintenanceResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fleetAssetId!: string;

  @ApiProperty()
  serviceDate!: Date;

  @ApiProperty({ required: false, nullable: true })
  mileage!: number | null;

  @ApiProperty({ required: false, nullable: true })
  technician!: string | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  cost!: Prisma.Decimal | null;

  @ApiProperty({ required: false, nullable: true })
  nextServiceDue!: Date | null;

  @ApiProperty({ enum: FleetMaintenanceStatus })
  status!: FleetMaintenanceStatus;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
