import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

function parseBooleanInput(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return Boolean(value);
}

function parseAliasesInput(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        // fallback to comma split
      }
    }
    return trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return undefined;
}

export const ADMIN_PHOTO_STATUS_FILTERS = ['ALL', 'DRAFT', 'APPROVED', 'REJECTED', 'RETIRED'] as const;
export type AdminPhotoStatusFilter = (typeof ADMIN_PHOTO_STATUS_FILTERS)[number];

export class QueryAdminCataloguePhotosDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  speciesId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ADMIN_PHOTO_STATUS_FILTERS })
  @IsOptional()
  @IsIn(ADMIN_PHOTO_STATUS_FILTERS)
  status?: AdminPhotoStatusFilter;
}

export class UploadCataloguePhotoDto {
  @ApiProperty()
  @IsUUID()
  speciesId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  catalogueItemId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(({ value }) => parseAliasesInput(value))
  @IsArray()
  @IsString({ each: true })
  jamaicanAliases?: string[];

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  photographer!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  sourceName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceUrl?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  licenseName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  licenseUrl?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  modifications!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => parseBooleanInput(value))
  @IsBoolean()
  requiresAttribution?: boolean;
}

export class UpdateCataloguePhotoMetadataDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(({ value }) => parseAliasesInput(value))
  @IsArray()
  @IsString({ each: true })
  jamaicanAliases?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  photographer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  sourceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  licenseName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  licenseUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  modifications?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => parseBooleanInput(value))
  @IsBoolean()
  requiresAttribution?: boolean;
}

export class ReplaceCataloguePhotoDto extends UpdateCataloguePhotoMetadataDto {
  @ApiPropertyOptional({
    description:
      'Administrator-only option to publish the replacement directly; non-admin editors always create a private draft version.',
  })
  @IsOptional()
  @Transform(({ value }) => parseBooleanInput(value))
  @IsBoolean()
  publishImmediately?: boolean;

  @ApiPropertyOptional({
    description: 'Administrator-only option to make the published replacement default for its species.',
  })
  @IsOptional()
  @Transform(({ value }) => parseBooleanInput(value))
  @IsBoolean()
  setAsDefault?: boolean;
}

export class ApproveCataloguePhotoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => parseBooleanInput(value))
  @IsBoolean()
  setAsDefault?: boolean;
}

export class RejectCataloguePhotoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RetireCataloguePhotoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BulkSwitchListingPhotosDto {
  @ApiProperty()
  @IsUUID()
  fromPhotoId!: string;

  @ApiProperty({ description: 'Explicit confirmation required to update existing vendor product images.' })
  @IsBoolean()
  confirmBulkSwitch!: boolean;
}
