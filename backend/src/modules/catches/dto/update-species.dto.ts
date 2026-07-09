import { ApiProperty } from '@nestjs/swagger';
import { RegulatoryStatus } from '@prisma/client';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class UpdateSpeciesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  commercialName?: string;

  @ApiProperty({ enum: RegulatoryStatus, required: false })
  @IsOptional()
  @IsEnum(RegulatoryStatus)
  regulatoryStatus?: RegulatoryStatus;

  @ApiProperty({ required: false, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  seasonalStartMonth?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  seasonalEndMonth?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumSizeCm?: number;
}
