import { ApiProperty } from '@nestjs/swagger';

import { ComplianceBand } from '../utils/compliance-score-band.util';

class ComplianceScoreBreakdownEntity {
  @ApiProperty({ description: 'Recomputed score from current signals (may differ from the stored score)' })
  score!: number;

  @ApiProperty()
  temperatureDeduction!: number;

  @ApiProperty()
  inspectionDeduction!: number;

  @ApiProperty()
  recallDeduction!: number;

  @ApiProperty()
  certificationDeduction!: number;
}

// Admin-only explanation of a vendor's compliance score (Phase 13C).
export class ComplianceScoreExplanationEntity {
  @ApiProperty()
  vendorId!: string;

  @ApiProperty({ nullable: true, description: 'Stored score; null if never assessed' })
  score!: number | null;

  @ApiProperty({ enum: ComplianceBand })
  band!: ComplianceBand;

  @ApiProperty({ nullable: true })
  updatedAt!: Date | null;

  @ApiProperty({ type: ComplianceScoreBreakdownEntity })
  breakdown!: ComplianceScoreBreakdownEntity;
}
