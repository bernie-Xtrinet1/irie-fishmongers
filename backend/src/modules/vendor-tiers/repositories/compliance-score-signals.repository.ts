import { Injectable } from '@nestjs/common';
import { VendorTier } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { tierRequiresCertification } from '../vendor-tier.constants';
import { ComplianceSignals } from '../utils/compliance-score-formula.util';

const TEMPERATURE_WINDOW_DAYS = 90;
const INSPECTION_WINDOW_DAYS = 180;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Gathers the four food-safety signal categories the compliance formula
// needs, each read directly from the owning module's tables via the global
// PrismaService (Phase 13C). Every count is deliberately deduped:
//
// - Recalls are counted per DISTINCT recall (one recall touching three of a
//   vendor's lots deducts once), because the query counts Recall rows that
//   have at least one matching lot, not RecallLot rows.
// - Certifications are counted per certification row on the vendor directly.
// - Temperature alerts are naturally distinct rows (one per breaching
//   reading); duplicate-sensor deduplication is an explicit future concern,
//   out of scope here.
// - Inspections are attributed to the lot's current vendor. This platform
//   has no lot-to-vendor reassignment (SeafoodLot.vendorId is set at
//   registration and never moved), so "the lot's vendor" is also "the
//   vendor at inspection time".
@Injectable()
export class ComplianceScoreSignalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async gather(vendorId: string, tier: VendorTier): Promise<ComplianceSignals> {
    const [temperatureGroups, inspectionGroups, activeRecalls, expiredCerts, activeCerts] = await Promise.all([
      this.prisma.temperatureAlert.groupBy({
        by: ['severity'],
        where: { resolved: false, createdAt: { gte: daysAgo(TEMPERATURE_WINDOW_DAYS) }, lot: { vendorId } },
        _count: { _all: true },
      }),
      this.prisma.qualityInspection.groupBy({
        by: ['result'],
        where: {
          inspectedAt: { gte: daysAgo(INSPECTION_WINDOW_DAYS) },
          result: { in: ['REJECTED', 'QUARANTINED', 'CONDITIONAL'] },
          lot: { vendorId },
        },
        _count: { _all: true },
      }),
      this.prisma.recall.count({
        where: { status: { in: ['ACTIVE', 'INVESTIGATING'] }, lots: { some: { lot: { vendorId } } } },
      }),
      this.prisma.regulatoryCertification.count({ where: { vendorId, status: 'EXPIRED' } }),
      this.prisma.regulatoryCertification.count({ where: { vendorId, status: 'ACTIVE' } }),
    ]);

    const temperatureCountBy = (severity: 'WARNING' | 'CRITICAL' | 'EMERGENCY'): number =>
      temperatureGroups.find((group) => group.severity === severity)?._count._all ?? 0;
    const inspectionCountBy = (result: 'REJECTED' | 'QUARANTINED' | 'CONDITIONAL'): number =>
      inspectionGroups.find((group) => group.result === result)?._count._all ?? 0;

    return {
      temperatureAlerts: {
        warning: temperatureCountBy('WARNING'),
        critical: temperatureCountBy('CRITICAL'),
        emergency: temperatureCountBy('EMERGENCY'),
      },
      inspections: {
        rejected: inspectionCountBy('REJECTED'),
        quarantined: inspectionCountBy('QUARANTINED'),
        conditional: inspectionCountBy('CONDITIONAL'),
      },
      activeRecalls,
      certifications: {
        expired: expiredCerts,
        requiresCertifications: tierRequiresCertification(tier),
        hasActiveCertification: activeCerts > 0,
      },
    };
  }
}
