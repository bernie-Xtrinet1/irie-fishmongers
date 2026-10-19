import { ApiProperty } from '@nestjs/swagger';
import { CatalogueCompositionMode, RegulatoryStatus } from '@prisma/client';

export class SpeciesEvaluationDetailEntity {
  @ApiProperty()
  speciesId!: string;

  @ApiProperty()
  scientificName!: string;

  @ApiProperty()
  commercialName!: string;

  @ApiProperty({ enum: RegulatoryStatus })
  regulatoryStatus!: RegulatoryStatus;

  @ApiProperty({ required: false, nullable: true })
  inSeason!: boolean | null;

  @ApiProperty()
  prohibited!: boolean;
}

export class RegulatoryEvaluationDetailsEntity {
  @ApiProperty({ enum: CatalogueCompositionMode, required: false })
  compositionMode?: CatalogueCompositionMode;

  @ApiProperty({ type: [SpeciesEvaluationDetailEntity], required: false })
  speciesEvaluated?: SpeciesEvaluationDetailEntity[];

  @ApiProperty({ required: false })
  overrideApplied?: boolean;
}

export class RegulatoryEvaluationResultEntity {
  @ApiProperty()
  eligible!: boolean;

  @ApiProperty({ type: [String] })
  reasons!: string[];

  @ApiProperty()
  evaluatedAt!: Date;

  @ApiProperty({ enum: ['ENFORCING', 'DEGRADED_FAIL_CLOSED'] })
  mode!: 'ENFORCING' | 'DEGRADED_FAIL_CLOSED';

  @ApiProperty({ type: RegulatoryEvaluationDetailsEntity, required: false })
  details?: RegulatoryEvaluationDetailsEntity;
}
