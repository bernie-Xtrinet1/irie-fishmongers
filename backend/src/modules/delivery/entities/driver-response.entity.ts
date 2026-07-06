import { ApiProperty } from '@nestjs/swagger';
import { DriverStatus, VehicleType } from '@prisma/client';

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

  @ApiProperty()
  createdAt!: Date;
}
