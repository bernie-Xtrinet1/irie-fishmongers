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

export class UpdateCatalogueItemDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  scientificName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  scientificFamily?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  commonName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  jamaicanNames?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ enum: CatalogueCompositionMode, required: false })
  @IsOptional()
  @IsEnum(CatalogueCompositionMode)
  compositionMode?: CatalogueCompositionMode;

  @ApiProperty({ required: false, type: [LinkSpeciesDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LinkSpeciesDto)
  species?: LinkSpeciesDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  referenceImageUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  imageSourceLicense?: string;

  @ApiProperty({ enum: ProductUnit, required: false })
  @IsOptional()
  @IsEnum(ProductUnit)
  typicalUnit?: ProductUnit;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalSizeMinCm?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalSizeMaxCm?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalWeightMinLbs?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  typicalWeightMaxLbs?: number;
}
