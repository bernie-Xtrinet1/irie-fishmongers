import { ApiProperty } from '@nestjs/swagger';
import { SeafoodStorageType } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateTemperatureThresholdDto {
  @ApiProperty({ required: false, description: 'Omit for a platform-wide default threshold' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiProperty({ enum: SeafoodStorageType })
  @IsEnum(SeafoodStorageType)
  storageType!: SeafoodStorageType;

  @ApiProperty({ example: 0 })
  @IsNumber()
  minC!: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  maxC!: number;

  @ApiProperty({ example: 3, description: 'Degrees past minC/maxC before WARNING escalates to CRITICAL, and 2x this before EMERGENCY' })
  @IsNumber()
  warningBandC!: number;
}
