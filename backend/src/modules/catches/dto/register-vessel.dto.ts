import { ApiProperty } from '@nestjs/swagger';
import { FishingMethod } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';

export class RegisterVesselDto {
  @ApiProperty()
  @IsString()
  registrationNumber!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ enum: FishingMethod })
  @IsEnum(FishingMethod)
  fishingMethod!: FishingMethod;

  @ApiProperty({ required: false, example: 2.5 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  capacityTons?: number;
}
