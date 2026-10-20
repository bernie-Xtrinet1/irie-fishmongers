import { ApiPropertyOptional } from '@nestjs/swagger';
import { ListingLifecycleStatus, Parish, ProductUnit } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryDailyListingsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by vendor UUID' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ description: 'Filter by master catalogue item UUID' })
  @IsOptional()
  @IsUUID()
  catalogueItemId?: string;

  @ApiPropertyOptional({ description: 'Filter by catalogue category UUID' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by linked species UUID' })
  @IsOptional()
  @IsUUID()
  speciesId?: string;

  @ApiPropertyOptional({ description: 'Filter by landing site UUID' })
  @IsOptional()
  @IsUUID()
  landingSiteId?: string;

  @ApiPropertyOptional({ enum: Parish, description: 'Filter by parish of vendor or landing site' })
  @IsOptional()
  @IsEnum(Parish)
  parish?: Parish;

  @ApiPropertyOptional({ description: 'Minimum price' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum price' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ProductUnit, description: 'Filter by product selling unit' })
  @IsOptional()
  @IsEnum(ProductUnit)
  unit?: ProductUnit;

  @ApiPropertyOptional({ description: 'Filter listings offering custom preparation options' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  hasPreparationOptions?: boolean;

  @ApiPropertyOptional({ description: 'Filter listings with delivery available' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  deliveryAvailable?: boolean;

  @ApiPropertyOptional({ description: 'Filter listings with pickup available' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  pickupAvailable?: boolean;

  @ApiPropertyOptional({ enum: ListingLifecycleStatus, description: 'Filter by stored lifecycle status' })
  @IsOptional()
  @IsEnum(ListingLifecycleStatus)
  status?: ListingLifecycleStatus;

  @ApiPropertyOptional({
    description: 'Filter only active, published, non-expired listings (Available Today)',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;

  @ApiPropertyOptional({ description: 'Search title, description, or catalogue species/common name' })
  @IsOptional()
  @IsString()
  search?: string;
}
