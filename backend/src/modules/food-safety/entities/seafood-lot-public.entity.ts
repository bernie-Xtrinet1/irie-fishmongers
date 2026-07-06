import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, SeafoodStorageType } from '@prisma/client';

// Customer-facing traceability view (traceability-requirements.md's
// "Customer Traceability" section: species, catch date, landing site,
// vendor, freshness grade, temperature verification) - deliberately omits
// vendorId/qualityScore/statusNotes/internal foodSafetyStatus detail.
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
  landingSite!: string | null;

  @ApiProperty({ enum: FreshnessGrade, required: false, nullable: true })
  freshnessGrade!: FreshnessGrade | null;

  @ApiProperty()
  vendorBusinessName!: string;

  @ApiProperty({ description: 'Whether every temperature checkpoint for this lot has stayed within range' })
  temperatureVerified!: boolean;
}
