import { ApiProperty } from '@nestjs/swagger';
import { DriverAvailabilityStatus, DriverStatus, Prisma, VehicleType } from '@prisma/client';

export class DriverResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  licensePlate!: string;

  @ApiProperty({ enum: VehicleType })
  vehicleType!: VehicleType;

  @ApiProperty({ enum: DriverStatus })
  status!: DriverStatus;

  @ApiProperty({ enum: DriverAvailabilityStatus })
  availabilityStatus!: DriverAvailabilityStatus;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    description: 'Maximum load capacity in pounds',
  })
  capacityLbs!: Prisma.Decimal | null;

  @ApiProperty()
  coldChainCapable!: boolean;

  @ApiProperty()
  createdAt!: Date;
}
