import { ApiProperty } from '@nestjs/swagger';
import { Parish, VendorTier } from '@prisma/client';

export enum VendorComplianceStatusLabel {
  NOT_YET_ASSESSED = 'NOT_YET_ASSESSED',
  COMPLIANT = 'COMPLIANT',
  AT_RISK = 'AT_RISK',
  NON_COMPLIANT = 'NON_COMPLIANT',
}

// Rating/coldChainScore/recentReviews are always null/empty today - no
// Review/Rating model or cold-chain scoring engine exists yet in this
// codebase (see docs/database-design.md's Marketplace Selection Engine
// scope notes). Surfacing an honest empty/neutral value here, not a
// fabricated one, per vendor-screens.md's VENDOR PROFILE SCREEN spec.
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

  @ApiProperty({ type: [String] })
  recentReviews!: [];
}
