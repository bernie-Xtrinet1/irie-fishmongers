import { ApiProperty } from '@nestjs/swagger';
import { AlertSeverity, FishermanStatus, VendorStatus } from '@prisma/client';

class AlertsBySeverityEntity implements Record<AlertSeverity, number> {
  @ApiProperty()
  WARNING!: number;

  @ApiProperty()
  CRITICAL!: number;

  @ApiProperty()
  EMERGENCY!: number;
}

class VendorsByStatusEntity implements Record<VendorStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  APPROVED!: number;

  @ApiProperty()
  SUSPENDED!: number;

  @ApiProperty()
  REJECTED!: number;
}

class FishermenByStatusEntity implements Record<FishermanStatus, number> {
  @ApiProperty()
  PENDING!: number;

  @ApiProperty()
  APPROVED!: number;

  @ApiProperty()
  SUSPENDED!: number;

  @ApiProperty()
  REJECTED!: number;
}

class VendorComplianceSummaryEntity {
  @ApiProperty({ type: VendorsByStatusEntity })
  countByStatus!: VendorsByStatusEntity;

  @ApiProperty({ required: false, nullable: true })
  averageComplianceScore!: number | null;
}

export class ComplianceDashboardEntity {
  @ApiProperty({ type: AlertsBySeverityEntity })
  activeAlertsBySeverity!: AlertsBySeverityEntity;

  @ApiProperty()
  failedInspectionsLast30Days!: number;

  @ApiProperty()
  lotsPendingReview!: number;

  @ApiProperty()
  activeRecalls!: number;

  @ApiProperty({ type: VendorComplianceSummaryEntity })
  vendorCompliance!: VendorComplianceSummaryEntity;

  @ApiProperty({ type: FishermenByStatusEntity })
  fishermenByStatus!: FishermenByStatusEntity;

  @ApiProperty()
  generatedAt!: Date;
}
