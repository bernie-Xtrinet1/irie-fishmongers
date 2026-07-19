import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateFleetTripDto {
  @ApiProperty()
  @IsString()
  fleetAssetId!: string;

  @ApiProperty()
  @IsString()
  driverId!: string;

  @ApiProperty()
  @IsString()
  zoneId!: string;

  @ApiProperty()
  @IsDateString()
  startedAt!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fuelCost?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  driverWage?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maintenanceAllocation?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  insuranceAllocation?: number;
}
