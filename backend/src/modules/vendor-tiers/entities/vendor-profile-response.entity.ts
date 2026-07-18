import { ApiProperty } from '@nestjs/swagger';
import { Parish, VendorTier } from '@prisma/client';

import { ReviewResponseEntity } from '../../reviews/entities/review-response.entity';
import { ComplianceBand } from '../utils/compliance-score-band.util';

export enum VendorComplianceStatusLabel {
  NOT_YET_ASSESSED = 'NOT_YET_ASSESSED',
  COMPLIANT = 'COMPLIANT',
  AT_RISK = 'AT_RISK',
  NON_COMPLIANT = 'NON_COMPLIANT',
}

// rating and recentReviews are populated from ReviewsQueryService (Phase
// 13E); complianceScore/complianceBand come from the Phase 13C engine.
// coldChainScore stays null - no cold-chain scoring engine exists yet (see
// docs/database-design.md's Marketplace Selection Engine scope notes) -
// surfaced as an honest null, not a fabricated value.
export class VendorProfileResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ enum: VendorTier })
  tier!: VendorTier;

  @ApiProperty()
  badge!: string;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  complianceScore!: number | null;

  @ApiProperty({ enum: ComplianceBand })
  complianceBand!: ComplianceBand;

  @ApiProperty({ required: false, nullable: true })
  complianceScoreUpdatedAt!: Date | null;

  @ApiProperty({ enum: VendorComplianceStatusLabel })
  foodSafetyStatus!: VendorComplianceStatusLabel;

  @ApiProperty({ enum: VendorComplianceStatusLabel })
  traceabilityStatus!: VendorComplianceStatusLabel;

  @ApiProperty()
  ordersCompleted!: number;

  @ApiProperty({ nullable: true })
  rating!: number | null;

  @ApiProperty({ nullable: true })
  coldChainScore!: number | null;

  @ApiProperty({ type: ReviewResponseEntity, isArray: true })
  recentReviews!: ReviewResponseEntity[];
}
