import { ApiProperty } from '@nestjs/swagger';
import { CataloguePhotoApprovalStatus, RegulatoryStatus } from '@prisma/client';

export class CataloguePhotoSpeciesEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  commercialName!: string;

  @ApiProperty()
  scientificName!: string;

  @ApiProperty({ enum: RegulatoryStatus })
  regulatoryStatus!: RegulatoryStatus;
}

export class CataloguePhotoEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  speciesId!: string;

  @ApiProperty({ required: false, nullable: true })
  catalogueItemId!: string | null;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  scientificName!: string;

  @ApiProperty({ type: [String] })
  jamaicanAliases!: string[];

  @ApiProperty()
  imageUrl!: string;

  @ApiProperty()
  sourceName!: string;

  @ApiProperty()
  sourceUrl!: string;

  @ApiProperty()
  photographer!: string;

  @ApiProperty()
  licenseName!: string;

  @ApiProperty()
  licenseUrl!: string;

  @ApiProperty()
  modifications!: string;

  @ApiProperty()
  requiresAttribution!: boolean;

  @ApiProperty({ enum: CataloguePhotoApprovalStatus })
  approvalStatus!: CataloguePhotoApprovalStatus;

  @ApiProperty({ required: false })
  isDefault?: boolean;

  @ApiProperty({ required: false })
  versionGroupId?: string;

  @ApiProperty({ required: false })
  versionNumber?: number;

  @ApiProperty({ required: false, nullable: true })
  retiredAt?: Date | string | null;

  @ApiProperty({ required: false, type: CataloguePhotoSpeciesEntity })
  species?: CataloguePhotoSpeciesEntity;
}
