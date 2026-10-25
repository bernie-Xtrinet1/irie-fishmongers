import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
} from '@prisma/client';

export const SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Disclosed preparation service selected at purchase time.
 * Monetary fee is strictly represented as a normalized decimal string with up to 2 decimal places.
 */
export interface PurchaseSnapshotPreparationOption {
  readonly id: string;
  readonly name: string;
  readonly fee: string;
  readonly currency: string;
}

/**
 * Customer checkout ceiling consent captured at purchase time.
 * Authorized ceiling is strictly represented as a normalized decimal string with up to 2 decimal places.
 */
export interface PurchaseSnapshotCeilingConsent {
  readonly authorizedCeilingJmd: string;
  readonly termsVersion: string;
  readonly payloadHash?: string;
  readonly consentedAt?: string;
}

/**
 * Version 1 of the immutable purchase-time seafood provenance snapshot.
 * Persisted into OrderItem.purchaseSnapshot as immutable JSONB evidence.
 * All monetary amounts are strictly represented as normalized decimal strings (JMD precision).
 */
export interface SeafoodPurchaseSnapshotV1 {
  readonly schemaVersion: typeof SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION;
  readonly originalLotId: string;
  readonly originalListingId: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly productName: string;
  readonly productDescription?: string;
  readonly species?: string;
  readonly pricingBasis: SeafoodPricingBasis;
  readonly currency: string;
  readonly unitPrice: string;
  readonly unit: ProductUnit;
  readonly pieceCount: number;
  readonly estimatedWeightLbs?: number;
  readonly selectedPreparationOption?: PurchaseSnapshotPreparationOption;
  readonly usablePartsPreference?: UsablePartsPreference;
  readonly ceilingConsent?: PurchaseSnapshotCeilingConsent;
  readonly purchasedAt: string;
}

/**
 * Thrown when an update attempts to modify, rewrite, or nullify immutable provenance fields.
 */
export class ProvenanceImmutabilityViolationError extends Error {
  constructor(
    public readonly orderItemId: string,
    public readonly violatedField: string,
    public readonly originalValue: unknown,
    public readonly attemptedValue: unknown,
  ) {
    super(
      `Provenance immutability violation on OrderItem "${orderItemId}": field "${violatedField}" is immutable once established. Original: "${String(originalValue)}", Attempted: "${String(attemptedValue)}".`,
    );
    this.name = 'ProvenanceImmutabilityViolationError';
  }
}

/**
 * Thrown when cross-entity provenance relationships are inconsistent or mismatched.
 */
export class ProvenanceConsistencyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceConsistencyViolationError';
  }
}

/**
 * Thrown when a purchase snapshot structure violates schema contracts or version invariants.
 */
export class InvalidPurchaseSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPurchaseSnapshotError';
  }
}

/**
 * Thrown when an attempt is made to synthesize or backfill historical provenance from mutable Product records.
 */
export class SyntheticProvenanceForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticProvenanceForbiddenError';
  }
}
