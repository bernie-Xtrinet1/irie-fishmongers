import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, SeafoodStorageType } from '@prisma/client';

// Customer-facing traceability view (traceability-requirements.md's
// "Customer Traceability" section: species, catch date, landing site,
// vendor, freshness grade, temperature verification, quality/freshness
// score) - deliberately omits vendorId/statusNotes/internal
// foodSafetyStatus detail. qualityScore is included with its
// lastInspectedAt "as of" date (Phase 13D) so a customer never sees a
// bare number with no indication of how current it is.
export class SeafoodLotPublicEntity {
  @ApiProperty()
  lotNumber!: string;

  @ApiProperty()
  species!: string;

  @ApiProperty({ enum: SeafoodStorageType })
  storageType!: SeafoodStorageType;

  @ApiProperty()
  catchDate!: Date;

  @ApiProperty({ required: false, nullable: true })
  catchLocation!: string | null;

  @ApiProperty({ required: false, nullable: true })
  landingSite!: string | null;

  @ApiProperty({ enum: FreshnessGrade, required: false, nullable: true })
  freshnessGrade!: FreshnessGrade | null;

  @ApiProperty({ required: false, nullable: true, description: '0-100 quality/freshness score from the most recent inspection' })
  qualityScore!: number | null;

  @ApiProperty({ required: false, nullable: true, description: 'When the most recent QualityInspection for this lot was recorded' })
  lastInspectedAt!: Date | null;

  @ApiProperty()
  vendorBusinessName!: string;

  @ApiProperty({ description: 'Whether every temperature checkpoint for this lot has stayed within range' })
  temperatureVerified!: boolean;
}
