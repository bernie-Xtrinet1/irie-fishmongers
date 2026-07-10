import { Injectable } from '@nestjs/common';

import { RecallsRepository } from '../repositories/recalls.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';

export type ReportRow = Record<string, string>;

// Flat row-per-record shapes feeding both the JSON response and the CSV
// util (backend/src/common/utils/csv.util.ts) - the same rows, just two
// serializations, so the two formats can never drift from each other.
@Injectable()
export class ComplianceReportsService {
  constructor(
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly recallsRepository: RecallsRepository,
  ) {}

  async getTraceabilityReport(): Promise<ReportRow[]> {
    const lots = await this.lotsRepository.findAllForExport();
    return lots.map((lot) => ({
      lotNumber: lot.lotNumber,
      species: lot.species,
      storageType: lot.storageType,
      catchDate: lot.catchDate.toISOString(),
      catchLocation: lot.catchLocation ?? '',
      landingSite: lot.landingSite ?? '',
      vendorBusinessName: lot.vendor.businessName,
      freshnessGrade: lot.freshnessGrade ?? '',
      qualityScore: lot.qualityScore !== null ? String(lot.qualityScore) : '',
      foodSafetyStatus: lot.foodSafetyStatus,
      createdAt: lot.createdAt.toISOString(),
    }));
  }

  async getTemperatureComplianceReport(): Promise<ReportRow[]> {
    const alerts = await this.alertsRepository.findAllForExport();
    return alerts.map((alert) => ({
      lotId: alert.lotId,
      severity: alert.severity,
      actualC: alert.actualC.toString(),
      resolved: alert.resolved ? 'true' : 'false',
      resolvedAt: alert.resolvedAt?.toISOString() ?? '',
      createdAt: alert.createdAt.toISOString(),
    }));
  }

  async getRecallsReport(): Promise<ReportRow[]> {
    const recalls = await this.recallsRepository.findAllForExport();
    return recalls.map((recall) => ({
      id: recall.id,
      severityClass: recall.severityClass,
      status: recall.status,
      reason: recall.reason,
      rootCause: recall.rootCause ?? '',
      affectedLotCount: String(recall.lots.length),
      createdAt: recall.createdAt.toISOString(),
      closedAt: recall.closedAt?.toISOString() ?? '',
    }));
  }
}
