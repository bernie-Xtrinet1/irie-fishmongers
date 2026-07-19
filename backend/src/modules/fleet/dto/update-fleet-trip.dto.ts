import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateFleetTripDto {
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
