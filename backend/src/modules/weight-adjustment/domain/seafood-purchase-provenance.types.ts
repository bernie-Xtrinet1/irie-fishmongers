import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';

export const SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION = 1;
export const SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V1 = 1;
export const SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2 = 2;

/**
 * Approved preparation charge methods (WP4.3B.2F.1 / WP4.3B.4B).
 */
export enum PreparationChargeMethod {
  FIXED_PER_FISH = 'FIXED_PER_FISH',
  FIXED_PER_POUND = 'FIXED_PER_POUND',
  NO_PREPARATION = 'NO_PREPARATION',
}

/**
 * Disclosed preparation service selected at purchase time (V1).
 * Monetary fee is strictly represented as a normalized decimal string with up to 2 decimal places.
 */
export interface PurchaseSnapshotPreparationOption {
  readonly id: string;
  readonly name: string;
  readonly fee: string;
  readonly currency: string;
}

/**
 * Customer checkout ceiling consent captured at purchase time (V1).
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
 * Preparation service option captured at purchase time (V2).
 * Captures authoritative method, vendor rate, and calculated fee.
 */
export interface PurchaseSnapshotPreparationOptionV2 {
  readonly id: string;
  readonly name: string;
  readonly chargeMethod: PreparationChargeMethod;
  readonly rate: string; // Vendor preparation rate as normalized decimal string
  readonly fee: string;  // Calculated preparation fee as normalized decimal string
  readonly currency: 'JMD'; // Strictly canonical 'JMD' in V2
}

/**
 * Customer checkout ceiling consent and quote binding captured at purchase time (V2).
 * Captures the authoritative server-issued quote identity, payload digest, ceiling, and consent timestamp.
 *
 * NOTE: Structural snapshot validation verifies syntax, formatting, and mathematical bounds.
 * It does not prove live customer authentication or cryptographic signature validity, which
 * are enforced at checkout execution boundaries.
 */
export interface PurchaseSnapshotCeilingConsentV2 {
  readonly authorizedCeilingJmd: string;
  readonly termsVersion: string;
  /**
   * Server-issued quote identifier.
   * Per committed CheckoutQuoteService contract, this is a non-empty string identifier.
   */
  readonly quoteId: string;
  /**
   * Cryptographic HMAC payload digest (64-character hexadecimal SHA-256 hash).
   */
  readonly payloadHash: string;
  /**
   * ISO-8601 consent timestamp with explicit timezone indicator (e.g. 'Z' or '+/-HH:mm').
   */
  readonly consentedAt: string;
}

/**
 * Version 2 of the immutable purchase-time seafood provenance snapshot.
 * Supports future immutable recording of preparation charge methods, vendor rates,
 * verified fish counts, original whole-fish weights, and signed quote-consent evidence.
 */
export interface SeafoodPurchaseSnapshotV2 {
  readonly schemaVersion: typeof SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2;
  readonly originalLotId: string;
  readonly originalListingId: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly productName: string;
  readonly productDescription?: string;
  readonly species?: string;
  readonly pricingBasis: SeafoodPricingBasis;
  readonly currency: 'JMD';
  readonly unitPrice: string;
  readonly unit: ProductUnit;
  readonly pieceCount: number;

  // Physical measures and calculation basis evidence
  readonly fishCount?: number;
  /**
   * Canonical original whole-fish weight, already normalized to pounds prior to snapshot creation.
   * Used directly as the quantity basis for FIXED_PER_POUND preparation fee calculations.
   */
  readonly originalWholeWeightLbs?: number;
  /**
   * Informational metadata recording the unit of the vendor's original whole-fish measurement (e.g. POUNDS or KILOGRAMS).
   * Captured for audit and display purposes only. Because originalWholeWeightLbs is already normalized to pounds,
   * this field must NOT trigger secondary unit conversion during fee calculation or snapshot validation.
   */
  readonly originalWholeWeightUnit?: WeightUnit;
  readonly estimatedWeightLbs?: number;

  // Preparation & usable parts
  readonly selectedPreparationOption?: PurchaseSnapshotPreparationOptionV2;
  readonly usablePartsPreference?: UsablePartsPreference;

  // Mandatory ceiling consent evidence in V2
  readonly ceilingConsent: PurchaseSnapshotCeilingConsentV2;

  readonly purchasedAt: string;
}

/**
 * Discriminated union of purchase-time seafood provenance snapshots.
 */
export type SeafoodPurchaseSnapshot = SeafoodPurchaseSnapshotV1 | SeafoodPurchaseSnapshotV2;

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
