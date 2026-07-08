import { ApiProperty } from '@nestjs/swagger';
import { FleetMaintenanceStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateFleetMaintenanceDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  serviceDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  mileage?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  technician?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  nextServiceDue?: string;

  @ApiProperty({ enum: FleetMaintenanceStatus, required: false })
  @IsOptional()
  @IsEnum(FleetMaintenanceStatus)
  status?: FleetMaintenanceStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
