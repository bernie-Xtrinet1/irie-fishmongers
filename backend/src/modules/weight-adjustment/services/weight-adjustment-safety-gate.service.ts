import { Injectable, Logger } from '@nestjs/common';
import { FoodSafetyStatus, Prisma, RegulatoryStatus, VendorStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ColdChainBreachError,
  FoodSafetyIncidentActiveError,
  ProvenanceMismatchError,
  QualityInspectionFailedError,
  SeafoodListingExpiredError,
  SeafoodLotRecalledError,
  SeafoodSafetyHoldError,
  UnlinkedSeafoodLotError,
  VendorNotEligibleError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import {
  SafetyGateBlockingReason,
  SafetyGateEvaluationContext,
  SafetyGateEvaluationResult,
  SafetyGateWarningReason,
} from './types/weight-adjustment-safety.types';

@Injectable()
export class WeightAdjustmentSafetyGateService {
  private readonly logger = new Logger(WeightAdjustmentSafetyGateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates authoritative persisted records across multiple food safety dimensions.
   * Returns a structured result with blocking reasons and non-blocking warnings.
   * Never throws - caller decides whether to inspect reasons or fail closed.
   */
  async evaluateLotSafety(
    context: SafetyGateEvaluationContext,
    tx?: Prisma.TransactionClient,
  ): Promise<SafetyGateEvaluationResult> {
    const client = tx ?? this.prisma;
    const evaluatedAt = new Date();
    const blockingReasons: SafetyGateBlockingReason[] = [];
    const warnings: SafetyGateWarningReason[] = [];

    // 1. Fetch authoritative SeafoodLot with relations
    const lot = await client.seafoodLot.findUnique({
      where: { id: context.seafoodLotId },
      include: {
        vendor: { select: { id: true, status: true } },
        speciesRef: { select: { id: true, regulatoryStatus: true } },
        recallLots: {
          include: {
            recall: { select: { id: true, status: true, reason: true, severityClass: true } },
          },
        },
        temperatureAlerts: {
          where: { resolved: false },
        },
        incidents: {
          where: { status: { in: ['OPEN', 'INVESTIGATING'] } },
        },
        inspections: {
          orderBy: { inspectedAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!lot) {
      return {
        eligible: false,
        evaluatedAt,
        blockingReasons: ['UNLINKED_SEAFOOD_LOT'],
        warnings: [],
      };
    }

    // 2. Base food safety status check (SAFE default is necessary but never sufficient)
    if (lot.foodSafetyStatus !== FoodSafetyStatus.SAFE) {
      blockingReasons.push('SEAFOOD_LOT_NOT_SAFE');
    }

    // 3. Active or investigating recall check
    const activeRecall = lot.recallLots.find(
      (rl) => rl.recall.status === 'ACTIVE' || rl.recall.status === 'INVESTIGATING',
    );
    if (activeRecall || lot.foodSafetyStatus === FoodSafetyStatus.RECALLED) {
      blockingReasons.push('LOT_UNDER_ACTIVE_RECALL');
    }

    // 4. Cold-chain breach check (unresolved CRITICAL or EMERGENCY alerts)
    const hasCriticalTempAlert = lot.temperatureAlerts.some(
      (alert) => !alert.resolved && (alert.severity === 'CRITICAL' || alert.severity === 'EMERGENCY'),
    );
    if (hasCriticalTempAlert) {
      blockingReasons.push('UNRESOLVED_CRITICAL_TEMPERATURE_ALERT');
    }

    const hasWarningTempAlert = lot.temperatureAlerts.some(
      (alert) => !alert.resolved && alert.severity === 'WARNING',
    );
    if (hasWarningTempAlert) {
      warnings.push('NON_CRITICAL_TEMPERATURE_WARNING');
    }

    // 5. Open serious food safety incidents (HIGH or CRITICAL)
    const hasSeriousIncident = lot.incidents.some(
      (inc) =>
        (inc.status === 'OPEN' || inc.status === 'INVESTIGATING') &&
        (inc.severity === 'HIGH' || inc.severity === 'CRITICAL'),
    );
    if (hasSeriousIncident) {
      blockingReasons.push('UNRESOLVED_CRITICAL_SAFETY_INCIDENT');
    }

    // 6. Quality inspection checks
    const latestInspection = lot.inspections[0];
    if (latestInspection) {
      if (latestInspection.result === 'REJECTED' || latestInspection.result === 'QUARANTINED') {
        blockingReasons.push('BLOCKING_QUALITY_INSPECTION');
      } else if (latestInspection.result === 'CONDITIONAL') {
        // CONDITIONAL cannot be treated as PASSED without explicit clearance
        blockingReasons.push('CONDITIONAL_INSPECTION_UNRESOLVED');
      }

      if (latestInspection.freshnessGrade === 'GRADE_B' || latestInspection.freshnessGrade === 'GRADE_C') {
        warnings.push('LOWER_FRESHNESS_GRADE');
      }
    } else {
      // Determine if inspection evidence is mandatory for this species / context
      if (lot.speciesRef?.regulatoryStatus === RegulatoryStatus.RESTRICTED) {
        blockingReasons.push('MANDATORY_INSPECTION_MISSING');
      }
    }

    // 7. Vendor Daily Listing provenance & expiration (if listingId supplied)
    const evalTime = context.atDate ?? evaluatedAt;
    if (context.vendorDailyListingId) {
      const listing = await client.vendorDailyListing.findUnique({
        where: { id: context.vendorDailyListingId },
        select: { id: true, lotId: true, vendorId: true, expiresAt: true, status: true },
      });

      if (!listing) {
        blockingReasons.push('LISTING_LOT_PROVENANCE_MISMATCH');
      } else {
        if (listing.lotId !== lot.id) {
          blockingReasons.push('LISTING_LOT_PROVENANCE_MISMATCH');
        }
        if (listing.vendorId !== lot.vendorId) {
          blockingReasons.push('VENDOR_PROVENANCE_MISMATCH');
        }
      const evalTime = context.atDate ? new Date(context.atDate) : evaluatedAt;
      if (listing.expiresAt && new Date(listing.expiresAt).getTime() < evalTime.getTime()) {
        blockingReasons.push('LISTING_EXPIRED');
      } else if (
        listing.expiresAt &&
        new Date(listing.expiresAt).getTime() - evalTime.getTime() < 2 * 60 * 60 * 1000
      ) {
        warnings.push('LISTING_EXPIRING_SOON');
      }
      }
    }

    // 8. Vendor provenance and good standing
    if (context.vendorId && lot.vendorId !== context.vendorId) {
      blockingReasons.push('VENDOR_PROVENANCE_MISMATCH');
    }

    if (lot.vendor.status !== VendorStatus.APPROVED) {
      blockingReasons.push('VENDOR_NOT_IN_GOOD_STANDING');
    }

    // 9. Catch date validity (catch cannot be in the future beyond clock skew)
    if (lot.catchDate && new Date(lot.catchDate).getTime() > evalTime.getTime() + 60_000) {
      blockingReasons.push('CATCH_DATE_INVALID');
    }

    return {
      eligible: blockingReasons.length === 0,
      evaluatedAt,
      blockingReasons,
      warnings,
      lotStatus: lot.foodSafetyStatus,
      freshnessGrade: lot.freshnessGrade ?? latestInspection?.freshnessGrade ?? null,
      qualityScore: lot.qualityScore ?? latestInspection?.qualityScore ?? null,
    };
  }

  /**
   * Asserts safety, throwing explicit typed domain errors if any blocking conditions exist.
   * Fails closed whenever eligibility cannot be authoritatively established.
   */
  async assertLotSafeForFulfillment(
    context: SafetyGateEvaluationContext,
    tx?: Prisma.TransactionClient,
  ): Promise<SafetyGateEvaluationResult> {
    const result = await this.evaluateLotSafety(context, tx);
    if (result.eligible) {
      return result;
    }

    // Map highest severity blocking reason to typed domain error
    const primary = result.blockingReasons[0];

    switch (primary) {
      case 'UNLINKED_SEAFOOD_LOT':
        throw new UnlinkedSeafoodLotError(context.seafoodLotId);
      case 'LOT_UNDER_ACTIVE_RECALL':
        throw new SeafoodLotRecalledError(context.seafoodLotId);
      case 'UNRESOLVED_CRITICAL_TEMPERATURE_ALERT':
        throw new ColdChainBreachError(context.seafoodLotId);
      case 'UNRESOLVED_CRITICAL_SAFETY_INCIDENT':
        throw new FoodSafetyIncidentActiveError(context.seafoodLotId);
      case 'BLOCKING_QUALITY_INSPECTION':
      case 'CONDITIONAL_INSPECTION_UNRESOLVED':
      case 'MANDATORY_INSPECTION_MISSING':
        throw new QualityInspectionFailedError(
          context.seafoodLotId,
          primary === 'MANDATORY_INSPECTION_MISSING' ? 'MISSING_MANDATORY_INSPECTION' : primary,
        );
      case 'LISTING_LOT_PROVENANCE_MISMATCH':
      case 'VENDOR_PROVENANCE_MISMATCH':
        throw new ProvenanceMismatchError(`Traceable provenance violation for lot "${context.seafoodLotId}".`);
      case 'LISTING_EXPIRED':
        throw new SeafoodListingExpiredError(
          context.vendorDailyListingId ?? 'unknown',
          result.evaluatedAt,
        );
      case 'VENDOR_NOT_IN_GOOD_STANDING':
        throw new VendorNotEligibleError(context.vendorId);
      case 'SEAFOOD_LOT_NOT_SAFE':
      case 'CATCH_DATE_INVALID':
      default:
        throw new SeafoodSafetyHoldError(
          context.seafoodLotId,
          result.lotStatus ?? 'UNKNOWN',
          `Seafood lot "${context.seafoodLotId}" failed authoritative safety gate: ${result.blockingReasons.join(', ')}.`,
        );
    }
  }
}
