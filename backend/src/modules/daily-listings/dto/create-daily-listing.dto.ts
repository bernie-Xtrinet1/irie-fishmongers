import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { DeclareListingSpeciesDto } from './declare-listing-species.dto';
import { PreparationOptionDto } from './preparation-option.dto';

export class CreateDailyListingDto {
  @ApiProperty({ description: 'Master seafood catalogue item UUID', example: 'c56a4180-65aa-42ec-a945-5fd21dec0538' })
  @IsUUID()
  @IsNotEmpty()
  catalogueItemId: string;

  @ApiProperty({ description: 'Traceable SeafoodLot UUID (mandatory batch anchor)', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  @IsNotEmpty()
  lotId: string;

  @ApiPropertyOptional({ description: 'Optional Product UUID if linking an existing vendor product row' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Landing site UUID where the catch was landed' })
  @IsOptional()
  @IsUUID()
  landingSiteId?: string;

  @ApiPropertyOptional({ description: 'Vendor custom title for today’s catch', example: 'Fresh Morning Snapper Catch' })
  @IsOptional()
  @IsString()
  listingTitle?: string;

  @ApiPropertyOptional({ description: 'Optional catch or batch description notes' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Catch or stock-receipt date (ISO 8601)', example: '2026-10-19T05:00:00.000Z' })
  @IsISO8601()
  @IsNotEmpty()
  catchDate: string;

  @ApiPropertyOptional({ description: 'Available from timestamp (ISO 8601)', example: '2026-10-19T06:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  availableFrom?: string;

  @ApiProperty({ description: 'Expiry timestamp when listing stops being purchasable (ISO 8601)', example: '2026-10-19T20:00:00.000Z' })
  @IsISO8601()
  @IsNotEmpty()
  expiresAt: string;

  @ApiProperty({ enum: ProductUnit, description: 'Selling unit of measurement', default: ProductUnit.PER_POUND })
  @IsEnum(ProductUnit)
  unit: ProductUnit;

  @ApiProperty({ description: 'Price per unit in listing currency', example: 850.0 })
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiPropertyOptional({ description: 'Currency code', default: 'JMD', example: 'JMD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ description: 'Vendor stated starting quantity uploaded for this listing', example: 50.0 })
  @IsNumber()
  @IsPositive()
  quantityUploaded: number;

  @ApiPropertyOptional({ type: [PreparationOptionDto], description: 'Optional preparation services offered with this listing' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreparationOptionDto)
  preparationOptions?: PreparationOptionDto[];

  @ApiPropertyOptional({ description: 'Whether delivery fulfillment is available for this listing', default: true })
  @IsOptional()
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({ description: 'Whether customer pickup is available for this listing', default: true })
  @IsOptional()
  @IsBoolean()
  pickupAvailable?: boolean;

  @ApiPropertyOptional({
    type: [DeclareListingSpeciesDto],
    description: 'Listing-level species declarations (mandatory for VARIABLE_COMPOSITE catalogue items)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeclareListingSpeciesDto)
  speciesDeclarations?: DeclareListingSpeciesDto[];
}
