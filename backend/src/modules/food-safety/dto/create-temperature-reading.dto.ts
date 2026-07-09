import { ApiProperty } from '@nestjs/swagger';
import { TemperatureCheckpoint } from '@prisma/client';
import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateTemperatureReadingDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ required: false, description: 'The device that captured this reading, if any' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiProperty({ enum: TemperatureCheckpoint })
  @IsEnum(TemperatureCheckpoint)
  checkpoint!: TemperatureCheckpoint;

  @ApiProperty({ example: 2.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  temperatureC!: number;

  @ApiProperty({ required: false, example: 17.9714 })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiProperty({ required: false, example: -76.7931 })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiProperty({ required: false, example: 'https://cdn.example.com/temp-evidence/reading-1.jpg' })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}
