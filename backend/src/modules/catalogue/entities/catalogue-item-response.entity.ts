import { ApiProperty } from '@nestjs/swagger';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  CatalogueRetirementReason,
  ProductUnit,
  RegulatoryStatus,
} from '@prisma/client';

export class LinkedSpeciesEntity {
  @ApiProperty()
  speciesId!: string;

  @ApiProperty()
  scientificName!: string;

  @ApiProperty()
  commercialName!: string;

  @ApiProperty({ enum: RegulatoryStatus })
  regulatoryStatus!: RegulatoryStatus;

  @ApiProperty({ required: false, nullable: true })
  seasonalStartMonth!: number | null;

  @ApiProperty({ required: false, nullable: true })
  seasonalEndMonth!: number | null;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ required: false, nullable: true })
  typicalProportion!: string | null;
}

export class SeafoodCatalogueItemResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ required: false, nullable: true })
  scientificName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  scientificFamily!: string | null;

  @ApiProperty()
  commonName!: string;

  @ApiProperty({ type: [String] })
  jamaicanNames!: string[];

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty()
  categoryId!: string;

  @ApiProperty({ required: false, nullable: true })
  categoryName?: string;

  @ApiProperty({ enum: CatalogueCompositionMode })
  compositionMode!: CatalogueCompositionMode;

  @ApiProperty({ enum: CatalogueLifecycleStatus })
  lifecycleStatus!: CatalogueLifecycleStatus;

  @ApiProperty({ enum: CatalogueRetirementReason, required: false, nullable: true })
  retirementReason!: CatalogueRetirementReason | null;

  @ApiProperty({ required: false, nullable: true })
  retirementNotes!: string | null;

  @ApiProperty({ required: false, nullable: true })
  consolidatedIntoId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  referenceImageUrl!: string | null;

  @ApiProperty({ required: false, nullable: true })
  imageSourceLicense!: string | null;

  @ApiProperty({ enum: ProductUnit })
  typicalUnit!: ProductUnit;

  @ApiProperty({ required: false, nullable: true })
  typicalSizeMinCm!: string | null;

  @ApiProperty({ required: false, nullable: true })
  typicalSizeMaxCm!: string | null;

  @ApiProperty({ required: false, nullable: true })
  typicalWeightMinLbs!: string | null;

  @ApiProperty({ required: false, nullable: true })
  typicalWeightMaxLbs!: string | null;

  @ApiProperty({ type: [LinkedSpeciesEntity] })
  species!: LinkedSpeciesEntity[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
