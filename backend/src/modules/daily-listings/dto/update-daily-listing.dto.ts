import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

import { DeclareListingSpeciesDto } from './declare-listing-species.dto';
import { PreparationOptionDto } from './preparation-option.dto';

export class UpdateDailyListingDto {
  @ApiPropertyOptional({ description: 'Vendor custom title for today’s catch', example: 'Fresh Morning Snapper Catch' })
  @IsOptional()
  @IsString()
  listingTitle?: string;

  @ApiPropertyOptional({ description: 'Optional catch or batch description notes' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Expiry timestamp when listing stops being purchasable (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Price per unit in listing currency', example: 850.0 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

  @ApiPropertyOptional({
    description: 'Updated quantity uploaded (only modifiable while in DRAFT status)',
    example: 60.0,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  quantityUploaded?: number;

  @ApiPropertyOptional({ type: [PreparationOptionDto], description: 'Optional preparation services offered' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreparationOptionDto)
  preparationOptions?: PreparationOptionDto[];

  @ApiPropertyOptional({ description: 'Whether delivery fulfillment is available', default: true })
  @IsOptional()
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({ description: 'Whether customer pickup is available', default: true })
  @IsOptional()
  @IsBoolean()
  pickupAvailable?: boolean;

  @ApiPropertyOptional({
    type: [DeclareListingSpeciesDto],
    description: 'Updated listing-level species declarations (only while DRAFT)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeclareListingSpeciesDto)
  speciesDeclarations?: DeclareListingSpeciesDto[];
}
