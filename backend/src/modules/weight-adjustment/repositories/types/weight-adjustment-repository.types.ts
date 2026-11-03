import Decimal from 'decimal.js';
import {
  ApprovalChallengeStatus,
  CustomerApprovalAction,
  CustomerWeightApprovalStatus,
  FoodSafetyStatus,
  ObligationStatus,
  PaymentObligationDirection,
  PreparationChargeMethod,
  PreparationFeeStructure,
  SeafoodPricingBasis,
  SettlementChannel,
  UsablePartsFulfillmentOutcome,
  UsablePartsPreference,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';

/**
 * Thrown when CreateAdjustmentSnapshotInput fails structural or domain consistency validation.
 */
export class InvalidAdjustmentInputError extends Error {
  constructor(message: string) {
    super(`[INVALID ADJUSTMENT INPUT] ${message}`);
    this.name = 'InvalidAdjustmentInputError';
  }
}

/**
 * Thrown when RecordCheckoutConsentInput fails structural pairing or format validation.
 */
export class InvalidConsentInputError extends Error {
  constructor(message: string) {
    super(`[INVALID CONSENT INPUT] ${message}`);
    this.name = 'InvalidConsentInputError';
  }
}

/**
 * Input for creating an immutable purchase-time seafood order weight adjustment snapshot.
 *
 * NOTE ON VALIDATION RESPONSIBILITY:
 * Repository-level validation verifies strictly local structural consistency:
 * - Method-to-parameter matching (e.g., FIXED_PER_FISH requires positive integer fishCount;
 *   FIXED_PER_POUND requires positive originalWholeWeightLbs and unit).
 * - Positivity and numeric finiteness of weights and counts.
 *
 * It DOES NOT establish or verify authenticated customer consent, pricing authority,
 * or cryptographic quote validity. Those domain guarantees are strictly enforced
 * upstream by CheckoutQuoteService and the checkout placement transaction boundary
 * (WP4.3B.4A / WP4.3B.4B / WP4.3B.4E).
 *
 * Preserves 100% of historical V1 behavior when V2 fields are omitted.
 */
export interface CreateAdjustmentSnapshotInput {
  readonly orderItemId: string;
  readonly pricingBasis: SeafoodPricingBasis;
  readonly unit: WeightUnit;
  readonly unitPrice: Decimal | string | number;
  readonly pieceCount?: number;
  readonly estimatedBillableWeight: Decimal | string | number;
  readonly preparationServiceName?: string;
  readonly usablePartsPreference?: UsablePartsPreference;
  readonly preparationFeeStructure?: PreparationFeeStructure;
  readonly preparationFeeRate?: Decimal | string | number;
  readonly estimatedPreparationFee?: Decimal | string | number;
  readonly estimatedProductSubtotal: Decimal | string | number;
  readonly estimatedItemTotal: Decimal | string | number;
  readonly customerAuthorizedCeilingJmd: Decimal | string | number;

  // Additive V2 preparation & physical measures (Phase 16D WP4.3B.4C)
  readonly preparationChargeMethod?: PreparationChargeMethod;
  readonly fishCount?: number;
  readonly originalWholeWeightLbs?: Decimal | string | number;
  readonly originalWholeWeightUnit?: WeightUnit;
}

export interface AppendMeasurementEventInput {
  readonly weightAdjustmentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly pricingBasis: SeafoodPricingBasis;
  readonly unit: WeightUnit;
  readonly measuredWeight: Decimal | string | number;
  readonly scalePhotoUrl: string;
  readonly scaleDeviceIdentifier?: string;
  readonly scaleCalibrationDate?: Date;
  readonly operatorUserId: string;
  readonly correctionReason?: string;
}

export interface AppendPreparationEventInput {
  readonly weightAdjustmentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly preparedNetWeight?: Decimal | string | number;
  readonly partsOutcome: UsablePartsFulfillmentOutcome;
  readonly partsDisposalReason?: string;
  readonly preparedPhotoUrl?: string;
  readonly operatorUserId: string;
  readonly correctionReason?: string;
}

/**
 * Input for recording customer checkout ceiling consent at initial order placement.
 *
 * NOTE ON VALIDATION RESPONSIBILITY:
 * Repository-level validation verifies strictly structural integrity:
 * - Complete quote-field pairs: quoteId and quotePayloadHash must both be present together,
 *   or both omitted.
 * - Format validity: quotePayloadHash must be a 64-character lowercase hexadecimal SHA-256 digest.
 *
 * Repository validation DOES NOT verify:
 * - Cryptographic HMAC signature or token authenticity.
 * - Customer identity matching or quote expiration.
 * - Authenticated customer consent.
 *
 * Cryptographic quote verification and customer consent authorization are strictly
 * enforced upstream by CheckoutQuoteService (WP4.3B.4A) and the checkout transaction
 * boundary (WP4.3B.4E).
 *
 * Preserves 100% of historical V1 behavior when quoteId and quotePayloadHash are omitted.
 */
export interface RecordCheckoutConsentInput {
  readonly weightAdjustmentId: string;
  readonly authenticatedCustomerId: string;
  readonly initialEstimatedWeight: Decimal | string | number;
  readonly initialEstimatedTotal: Decimal | string | number;
  readonly authorizedCeilingJmd: Decimal | string | number;
  readonly termsVersion: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;

  // Additive V2 checkout quote identity & payload hash (Phase 16D WP4.3B.4C)
  readonly quoteId?: string;
  readonly quotePayloadHash?: string;
}

export interface RecordCustomerApprovalInput {
  readonly weightAdjustmentId: string;
  readonly measurementRevision: number;
  readonly authenticatedCustomerId: string;
  readonly proposedTotalJmd: Decimal | string | number;
  readonly authorizedCeilingJmd: Decimal | string | number;
  readonly action: CustomerApprovalAction;
  readonly rawApprovalToken: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly rejectionReason?: string;
}

export interface CreateApprovalChallengeInput {
  readonly weightAdjustmentId: string;
  readonly measurementRevision: number;
  readonly authenticatedCustomerId: string;
  readonly proposedTotalJmd: Decimal | string | number;
  readonly authorizedCeilingJmd: Decimal | string | number;
  readonly approvalTokenHash: string;
  readonly expiresAt: Date;
}

export interface ConsumeApprovalChallengeInput {
  readonly challengeId: string;
  readonly expectedMeasurementRevision: number;
  readonly authenticatedCustomerId: string;
  readonly expectedProposedTotalJmd?: Decimal | string | number;
  readonly expectedAuthorizedCeilingJmd?: Decimal | string | number;
  readonly consumedAt?: Date;
}

export interface RenewApprovalChallengeInput {
  readonly weightAdjustmentId: string;
  readonly measurementRevision: number;
  readonly authenticatedCustomerId: string;
  readonly proposedTotalJmd: Decimal | string | number;
  readonly authorizedCeilingJmd: Decimal | string | number;
  readonly newApprovalTokenHash: string;
  readonly newExpiresAt: Date;
  readonly revocationReason?: string;
}

export interface ValidateChallengeContext {
  readonly authenticatedCustomerId: string;
  readonly activeMeasurementRevision: number;
  readonly proposedTotalJmd: Decimal | string | number;
  readonly authorizedCeilingJmd: Decimal | string | number;
  readonly rawToken?: string;
}

export interface ChallengeValidationResult {
  readonly isValid: boolean;
  readonly reason?:
    | 'VALID'
    | 'CHALLENGE_ALREADY_CONSUMED'
    | 'CHALLENGE_REVOKED'
    | 'CHALLENGE_EXPIRED'
    | 'STALE_MEASUREMENT_REVISION'
    | 'CUSTOMER_MISMATCH'
    | 'AMOUNT_MISMATCH'
    | 'CEILING_MISMATCH'
    | 'INVALID_TOKEN';
  readonly message?: string;
}

export interface RecordObligationInput {
  readonly weightAdjustmentId: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly direction: PaymentObligationDirection;
  readonly amountJmd: Decimal | string | number;
  readonly status?: ObligationStatus;
}

export interface RecordSettlementEvidenceInput {
  readonly obligationId: string;
  readonly idempotencyKey: string;
  readonly settlementChannel: SettlementChannel;
  readonly amountSettled: Decimal | string | number;
  readonly externalReference?: string;
  readonly evidenceDocumentUrl?: string;
  readonly settledByUserId: string;
}

export interface UpdateAdjustmentStateInput {
  readonly verifiedBillableWeight?: Decimal | string | number;
  readonly preparedNetWeight?: Decimal | string | number;
  readonly weightDifference?: Decimal | string | number;
  readonly yieldLossWeight?: Decimal | string | number;
  readonly yieldLossPercent?: Decimal | string | number;
  readonly finalPreparationFee?: Decimal | string | number;
  readonly preparationFeeDifference?: Decimal | string | number;
  readonly finalProductSubtotal?: Decimal | string | number;
  readonly productSubtotalDifference?: Decimal | string | number;
  readonly finalItemTotal?: Decimal | string | number;
  readonly totalAdjustmentAmount?: Decimal | string | number;
  readonly customerApprovalStatus?: CustomerWeightApprovalStatus;
  readonly boundApprovalRevision?: number | null;
  readonly approvalReason?: string;
  readonly measurementStatus?: WeightMeasurementStatus;
  readonly activeMeasurementRevision?: number;
  readonly activePreparationRevision?: number;
  readonly usablePartsOutcome?: UsablePartsFulfillmentOutcome;
  readonly foodSafetyStatus?: FoodSafetyStatus;
}
