import { ApiProperty } from '@nestjs/swagger';
import { CatalogueCompositionMode, ProductUnit } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { LinkSpeciesDto } from './link-species.dto';

export class CreateCatalogueItemDto {
  @ApiProperty({ example: 'Red Snapper' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ required: false, example: 'Lutjanus analis' })
  @IsOptional()
  @IsString()
  scientificName?: string;

  @ApiProperty({ required: false, example: 'Lutjanidae' })
  @IsOptional()
  @IsString()
  scientificFamily?: string;

  @ApiProperty({ example: 'Mutton Snapper' })
  @IsString()
  @MinLength(2)
  commonName!: string;

  @ApiProperty({ required: false, example: ['Redman', 'Snapper', 'Mutton Snapper'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  jamaicanNames?: string[];

  @ApiProperty({ required: false, example: 'High-value prized reef fish, mild sweet flavor with firm flaky texture.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Category ID' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ enum: CatalogueCompositionMode, default: CatalogueCompositionMode.UNVERIFIED_COMPOSITION })
  @IsEnum(CatalogueCompositionMode)
  compositionMode!: CatalogueCompositionMode;

  @ApiProperty({ required: false, type: [LinkSpeciesDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LinkSpeciesDto)
  species?: LinkSpeciesDto[];

  @ApiProperty({ required: false, example: 'https://cdn.iriefishmongers.com/catalogue/red-snapper.jpg' })
  @IsOptional()
  @IsUrl()
  referenceImageUrl?: string;

  @ApiProperty({ required: false, example: 'Fisheries Division Jamaica / Public Domain' })
  @IsOptional()
  @IsString()
  imageSourceLicense?: string;

  @ApiProperty({ enum: ProductUnit, default: ProductUnit.PER_POUND })
  @IsOptional()
  @IsEnum(ProductUnit)
  typicalUnit?: ProductUnit;

  @ApiProperty({ required: false, example: 25.0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalSizeMinCm?: number;

  @ApiProperty({ required: false, example: 60.0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalSizeMaxCm?: number;

  @ApiProperty({ required: false, example: 1.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalWeightMinLbs?: number;

  @ApiProperty({ required: false, example: 12.0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalWeightMaxLbs?: number;
}
