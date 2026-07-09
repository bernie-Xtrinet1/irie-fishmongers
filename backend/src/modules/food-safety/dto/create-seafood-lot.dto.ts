import { ApiProperty } from '@nestjs/swagger';
import { SeafoodStorageType, WeightUnit } from '@prisma/client';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateSeafoodLotDto {
  @ApiProperty({
    required: false,
    description: 'Link a registered CatchItem (one species-specific line item of a Catch) for full traceability. When set, species/catchDate/weight/weightUnit/catchLocation/landingSite are derived from the catch item and any values supplied below are ignored.',
  })
  @IsOptional()
  @IsString()
  catchItemId?: string;

  @ApiProperty({
    required: false,
    description: 'Link a managed Species for regulatory/seasonal validation (ignored if catchItemId is set).',
  })
  @IsOptional()
  @IsString()
  speciesId?: string;

  @ApiProperty({
    required: false,
    example: 'Yellowfin Snapper',
    description: 'Required unless catchId is set.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  species?: string;

  @ApiProperty({ enum: SeafoodStorageType })
  @IsEnum(SeafoodStorageType)
  storageType!: SeafoodStorageType;

  @ApiProperty({ required: false, example: '2027-01-15', description: 'Required unless catchId is set.' })
  @IsOptional()
  @IsDateString()
  catchDate?: string;

  @ApiProperty({ required: false, example: 'North Coast, Trelawny' })
  @IsOptional()
  @IsString()
  catchLocation?: string;

  @ApiProperty({ required: false, example: 'Falmouth Landing Site' })
  @IsOptional()
  @IsString()
  landingSite?: string;

  @ApiProperty({ required: false, example: 50, description: 'Required unless catchId is set.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  weight?: number;

  @ApiProperty({ enum: WeightUnit, required: false, description: 'Required unless catchId is set.' })
  @IsOptional()
  @IsEnum(WeightUnit)
  weightUnit?: WeightUnit;
}
