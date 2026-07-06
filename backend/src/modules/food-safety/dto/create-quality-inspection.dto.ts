import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, InspectionResult } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateQualityInspectionDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ enum: InspectionResult })
  @IsEnum(InspectionResult)
  result!: InspectionResult;

  @ApiProperty({ enum: FreshnessGrade })
  @IsEnum(FreshnessGrade)
  freshnessGrade!: FreshnessGrade;

  @ApiProperty({ example: 92 })
  @IsInt()
  @Min(0)
  @Max(100)
  qualityScore!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}
