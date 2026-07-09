import { ApiProperty } from '@nestjs/swagger';
import { LandingSiteStatus, SiteInspectionStatus } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateLandingSiteDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({ enum: LandingSiteStatus, required: false })
  @IsOptional()
  @IsEnum(LandingSiteStatus)
  status?: LandingSiteStatus;

  @ApiProperty({ enum: SiteInspectionStatus, required: false })
  @IsOptional()
  @IsEnum(SiteInspectionStatus)
  inspectionStatus?: SiteInspectionStatus;
}
