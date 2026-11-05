import Decimal from 'decimal.js';
import {
  CustomerCheckoutCeilingConsent,
  PreparationChargeMethod,
  PreparationFeeStructure,
  SeafoodOrderWeightAdjustment,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';

export interface VerifiedOrderTimeEvidence {
  readonly lotId: string;
  readonly listingId: string;
}

export interface InitializeSnapshotInput {
  readonly orderItemId: string;
  readonly verifiedOrderTimeEvidence?: VerifiedOrderTimeEvidence;
  readonly authoritativeListingId?: string;
  readonly customerAuthorizedCeilingJmd?: Decimal | string | number;
  readonly termsVersion?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly explicitPricingBasis?: SeafoodPricingBasis;
  readonly selectedPreparationServiceName?: string;
  readonly usablePartsPreference?: UsablePartsPreference;

  // V2 Additive Fields for Provenance, Quoting & Catch-Weight Normalization
  readonly preparationChargeMethod?: PreparationChargeMethod;
  readonly fishCount?: number;
  readonly originalWholeWeightLbs?: Decimal | string | number;
  readonly originalWholeWeightUnit?: WeightUnit;
  readonly quoteId?: string;
  readonly quotePayloadHash?: string;
  readonly consentedAt?: string;
}

export type SnapshotInitializationStatus =
  | 'INITIALIZED'
  | 'IDEMPOTENT_REPLAY'
  | 'SKIPPED_LEGACY_PRODUCT';

export interface SnapshotInitializationResult {
  readonly status: SnapshotInitializationStatus;
  readonly weightAdjustment?: SeafoodOrderWeightAdjustment;
  readonly checkoutConsent?: CustomerCheckoutCeilingConsent;
  readonly reason?: string;
}
