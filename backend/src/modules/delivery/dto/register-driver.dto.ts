import { ApiProperty } from '@nestjs/swagger';
import { VehicleType } from '@prisma/client';
import { IsEnum, IsString, MinLength } from 'class-validator';

export class RegisterDriverDto {
  @ApiProperty({ example: 'AB 1234' })
  @IsString()
  @MinLength(3)
  licensePlate!: string;

  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicleType!: VehicleType;
}
