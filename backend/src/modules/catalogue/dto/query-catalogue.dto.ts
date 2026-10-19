import { ApiProperty } from '@nestjs/swagger';
import { CatalogueCompositionMode, CatalogueLifecycleStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class QueryCatalogueDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ required: false, description: 'Search term against name, commonName, scientificName, jamaicanNames' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, enum: CatalogueCompositionMode })
  @IsOptional()
  @IsEnum(CatalogueCompositionMode)
  compositionMode?: CatalogueCompositionMode;

  @ApiProperty({ required: false, enum: CatalogueLifecycleStatus })
  @IsOptional()
  @IsEnum(CatalogueLifecycleStatus)
  lifecycleStatus?: CatalogueLifecycleStatus;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1))
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 20))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
