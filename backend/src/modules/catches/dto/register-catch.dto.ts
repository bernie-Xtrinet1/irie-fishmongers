import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { RegisterCatchItemDto } from './register-catch-item.dto';

// Trip-level record: a single fishing trip routinely lands multiple species
// in one haul, so the per-species weight/species data lives on `items`
// rather than flat on the catch itself.
export class RegisterCatchDto {
  @ApiProperty()
  @IsString()
  landingSiteId!: string;

  @ApiProperty({ required: false, description: 'The vessel used for this trip, if registered' })
  @IsOptional()
  @IsString()
  vesselId?: string;

  @ApiProperty({ example: '2026-07-08' })
  @IsDateString()
  catchDate!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({ required: false, example: 'North Coast' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  fishingArea?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({}, { each: true })
  photos?: string[];

  @ApiProperty({ type: [RegisterCatchItemDto], description: 'One entry per species landed on this trip' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegisterCatchItemDto)
  items!: RegisterCatchItemDto[];
}
