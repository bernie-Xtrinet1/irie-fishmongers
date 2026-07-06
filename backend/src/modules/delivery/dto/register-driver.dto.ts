import { ApiProperty } from '@nestjs/swagger';
import { VehicleOwnership, VehicleType } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

export class RegisterDriverDto {
  @ApiProperty({ example: 'AB 1234' })
  @IsString()
  @MinLength(3)
  licensePlate!: string;

  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;

  @ApiProperty({
    enum: VehicleOwnership,
    description: 'Whether the driver uses their own vehicle or a company-owned one; determines the settlement compensation formula.',
  })
  @IsEnum(VehicleOwnership)
  vehicleOwnership!: VehicleOwnership;
}
