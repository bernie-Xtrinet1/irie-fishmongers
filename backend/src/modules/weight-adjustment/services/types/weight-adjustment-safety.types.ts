import { FoodSafetyStatus, FreshnessGrade, QualityInspection } from '@prisma/client';

export interface SafetyGateEvaluationContext {
  readonly seafoodLotId: string;
  readonly vendorId: string;
  readonly vendorDailyListingId?: string;
  readonly speciesId?: string;
  readonly atDate?: Date;
}

export type SafetyGateBlockingReason =
  | 'UNLINKED_SEAFOOD_LOT'
  | 'SEAFOOD_LOT_NOT_SAFE'
  | 'LOT_UNDER_ACTIVE_RECALL'
  | 'UNRESOLVED_CRITICAL_TEMPERATURE_ALERT'
  | 'UNRESOLVED_CRITICAL_SAFETY_INCIDENT'
  | 'BLOCKING_QUALITY_INSPECTION'
  | 'CONDITIONAL_INSPECTION_UNRESOLVED'
  | 'MANDATORY_INSPECTION_MISSING'
  | 'LISTING_LOT_PROVENANCE_MISMATCH'
  | 'VENDOR_PROVENANCE_MISMATCH'
  | 'LISTING_EXPIRED'
  | 'CATCH_DATE_INVALID'
  | 'VENDOR_NOT_IN_GOOD_STANDING';

export type SafetyGateWarningReason =
  | 'LOWER_FRESHNESS_GRADE'
  | 'NON_CRITICAL_TEMPERATURE_WARNING'
  | 'LISTING_EXPIRING_SOON';

export interface SafetyGateEvaluationResult {
  readonly eligible: boolean;
  readonly evaluatedAt: Date;
  readonly blockingReasons: SafetyGateBlockingReason[];
  readonly warnings: SafetyGateWarningReason[];
  readonly lotStatus?: FoodSafetyStatus;
  readonly freshnessGrade?: FreshnessGrade | null;
  readonly qualityScore?: number | null;
}
