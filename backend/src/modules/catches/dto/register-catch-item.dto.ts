import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, WeightUnit } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class RegisterCatchItemDto {
  @ApiProperty()
  @IsString()
  speciesId!: string;

  @ApiProperty({ example: 20 })
  @IsNumber()
  @IsPositive()
  weight!: number;

  @ApiProperty({ enum: WeightUnit })
  @IsEnum(WeightUnit)
  weightUnit!: WeightUnit;

  @ApiProperty({ enum: FreshnessGrade, required: false })
  @IsOptional()
  @IsEnum(FreshnessGrade)
  estimatedFreshness?: FreshnessGrade;
}
