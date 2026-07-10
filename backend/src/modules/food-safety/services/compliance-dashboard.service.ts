import { Injectable } from '@nestjs/common';

import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceDashboardEntity } from '../entities/compliance-dashboard.entity';
import { QualityInspectionsRepository } from '../repositories/quality-inspections.repository';
import { RecallsRepository } from '../repositories/recalls.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Computed-on-read, no materialized table - matches this codebase's
// existing precedent (getComplianceStatus, rating summaries, driver
// performance metrics). "Active recalls" means status === ACTIVE
// specifically, mirroring cold-chain-management.md's "Active Violations"
// terminology rather than every non-terminal status.
@Injectable()
export class ComplianceDashboardService {
  constructor(
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly inspectionsRepository: QualityInspectionsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly recallsRepository: RecallsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly fishermenRepository: FishermenRepository,
  ) {}

  async getDashboard(): Promise<ComplianceDashboardEntity> {
    const [
      activeAlertsBySeverity,
      failedInspectionsLast30Days,
      lotsPendingReview,
      activeRecalls,
      vendorCompliance,
      fishermenByStatus,
    ] = await Promise.all([
      this.alertsRepository.countUnresolvedBySeverity(),
      this.inspectionsRepository.countFailedSince(new Date(Date.now() - THIRTY_DAYS_MS)),
      this.lotsRepository.countByStatus('UNDER_REVIEW'),
      this.recallsRepository.countByStatus('ACTIVE'),
      this.vendorsRepository.getComplianceSummary(),
      this.fishermenRepository.countByStatus(),
    ]);

    return {
      activeAlertsBySeverity,
      failedInspectionsLast30Days,
      lotsPendingReview,
      activeRecalls,
      vendorCompliance,
      fishermenByStatus,
      generatedAt: new Date(),
    };
  }
}
