import Decimal from 'decimal.js';
import {
  CustomerCheckoutCeilingConsent,
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
