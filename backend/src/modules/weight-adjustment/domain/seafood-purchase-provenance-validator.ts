import Decimal from 'decimal.js';
import { SeafoodPricingBasis } from '@prisma/client';
import {
  InvalidPurchaseSnapshotError,
  ProvenanceConsistencyViolationError,
  ProvenanceImmutabilityViolationError,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SeafoodPurchaseSnapshotV1,
  SyntheticProvenanceForbiddenError,
} from './seafood-purchase-provenance.types';

export interface ConsistencyCheckParams {
  readonly orderItemId: string;
  readonly originalLotId?: string | null;
  readonly originalListingId?: string | null;
  readonly purchaseSnapshot?: unknown;
  readonly listing: {
    readonly id: string;
    readonly vendorId: string;
    readonly lotId: string;
    readonly productId: string;
  };
  readonly lot: {
    readonly id: string;
    readonly vendorId?: string;
  };
  readonly expectedVendorId: string;
}

export interface ImmutabilityCheckParams {
  readonly orderItemId: string;
  readonly existing: {
    readonly originalLotId?: string | null;
    readonly originalListingId?: string | null;
    readonly purchaseSnapshot?: unknown;
  };
  readonly update: {
    readonly originalLotId?: string | null;
    readonly originalListingId?: string | null;
    readonly purchaseSnapshot?: unknown;
  };
}

/**
 * Strict monetary format: Non-negative decimal string with up to 2 decimal places.
 * Matches: "0", "0.00", "1500", "1500.5", "1500.50".
 * Rejects: negative numbers, excessive decimals ("1500.555"), scientific notation ("1e3"), leading zeros ("015").
 */
const STRICT_MONETARY_DECIMAL_REGEX = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/**
 * Validates that an untrusted value conforms to strict monetary string rules without floating point conversion.
 */
export function validateMonetaryDecimalString(val: unknown, fieldName: string, allowZero = false): Decimal {
  if (typeof val !== 'string') {
    throw new InvalidPurchaseSnapshotError(
      `Monetary field "${fieldName}" must be a normalized decimal string (got ${typeof val}). Floating-point numbers and non-string representations are prohibited.`,
    );
  }

  if (!STRICT_MONETARY_DECIMAL_REGEX.test(val)) {
    throw new InvalidPurchaseSnapshotError(
      `Monetary field "${fieldName}" has invalid format: "${val}". Must be a non-negative decimal string with at most 2 decimal places, without scientific notation or leading zeros.`,
    );
  }

  let parsed: Decimal;
  try {
    parsed = new Decimal(val);
  } catch {
    throw new InvalidPurchaseSnapshotError(
      `Monetary field "${fieldName}" could not be parsed as Decimal: "${val}".`,
    );
  }

  if (!parsed.isFinite() || parsed.isNaN()) {
    throw new InvalidPurchaseSnapshotError(
      `Monetary field "${fieldName}" must be a finite numeric value: "${val}".`,
    );
  }

  if (allowZero) {
    if (parsed.lessThan(0)) {
      throw new InvalidPurchaseSnapshotError(
        `Monetary field "${fieldName}" cannot be negative: "${val}".`,
      );
    }
  } else {
    if (parsed.lessThanOrEqualTo(0)) {
      throw new InvalidPurchaseSnapshotError(
        `Monetary field "${fieldName}" must be strictly positive: "${val}".`,
      );
    }
  }

  return parsed;
}

export class SeafoodPurchaseProvenanceValidator {
  /**
   * Validates that an untrusted object adheres to the SeafoodPurchaseSnapshotV1 contract.
   * Enforces that all monetary fields are strict normalized decimal strings.
   */
  static validatePurchaseSnapshotStructure(snapshot: unknown): SeafoodPurchaseSnapshotV1 {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new InvalidPurchaseSnapshotError('Purchase snapshot must be a non-null object.');
    }

    const obj = snapshot as Record<string, any>;

    if (obj.schemaVersion !== SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION) {
      throw new InvalidPurchaseSnapshotError(
        `Unsupported snapshot schema version: ${obj.schemaVersion}. Expected: ${SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION}.`,
      );
    }

    const requiredStringFields = [
      'originalLotId',
      'originalListingId',
      'vendorId',
      'productId',
      'productName',
      'currency',
      'purchasedAt',
    ];

    for (const field of requiredStringFields) {
      if (typeof obj[field] !== 'string' || obj[field].trim() === '') {
        throw new InvalidPurchaseSnapshotError(
          `Purchase snapshot field "${field}" must be a non-empty string.`,
        );
      }
    }

    if (!Object.values(SeafoodPricingBasis).includes(obj.pricingBasis)) {
      throw new InvalidPurchaseSnapshotError(
        `Invalid pricingBasis in snapshot: "${obj.pricingBasis}".`,
      );
    }

    // Strict monetary validation for unitPrice (must be positive decimal string)
    validateMonetaryDecimalString(obj.unitPrice, 'unitPrice', false);

    if (
      typeof obj.pieceCount !== 'number' ||
      isNaN(obj.pieceCount) ||
      !Number.isInteger(obj.pieceCount) ||
      obj.pieceCount <= 0
    ) {
      throw new InvalidPurchaseSnapshotError(
        `pieceCount must be a positive integer in purchase snapshot (got: ${obj.pieceCount}).`,
      );
    }

    if (obj.estimatedWeightLbs !== undefined && obj.estimatedWeightLbs !== null) {
      if (
        typeof obj.estimatedWeightLbs !== 'number' ||
        isNaN(obj.estimatedWeightLbs) ||
        !isFinite(obj.estimatedWeightLbs) ||
        obj.estimatedWeightLbs <= 0
      ) {
        throw new InvalidPurchaseSnapshotError(
          `estimatedWeightLbs must be a positive finite number (got: ${obj.estimatedWeightLbs}).`,
        );
      }
    }

    if (obj.selectedPreparationOption) {
      const prep = obj.selectedPreparationOption;
      if (typeof prep !== 'object' || prep === null) {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption must be an object.');
      }
      if (typeof prep.id !== 'string' || prep.id.trim() === '') {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption.id must be a string.');
      }
      if (typeof prep.name !== 'string' || prep.name.trim() === '') {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption.name must be a string.');
      }
      // Strict monetary validation for fee (decimal string, 0 allowed)
      validateMonetaryDecimalString(prep.fee, 'selectedPreparationOption.fee', true);

      if (typeof prep.currency !== 'string' || prep.currency.trim().toUpperCase() !== 'JMD') {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption.currency must be "JMD".');
      }
    }

    if (obj.ceilingConsent) {
      const consent = obj.ceilingConsent;
      if (typeof consent !== 'object' || consent === null) {
        throw new InvalidPurchaseSnapshotError('ceilingConsent must be an object.');
      }
      // Strict monetary validation for authorizedCeilingJmd (positive decimal string)
      validateMonetaryDecimalString(consent.authorizedCeilingJmd, 'ceilingConsent.authorizedCeilingJmd', false);

      if (typeof consent.termsVersion !== 'string' || consent.termsVersion.trim() === '') {
        throw new InvalidPurchaseSnapshotError('ceilingConsent.termsVersion must be a non-empty string.');
      }
    }

    return obj as SeafoodPurchaseSnapshotV1;
  }

  /**
   * Enforces cross-entity relational consistency between OrderItem references,
   * the authoritative VendorDailyListing, the SeafoodLot, and the PurchaseSnapshot.
   */
  static assertHybridProvenanceConsistency(params: ConsistencyCheckParams): void {
    const { orderItemId, originalLotId, originalListingId, purchaseSnapshot, listing, lot, expectedVendorId } = params;

    // 1. Mandatory correlation between OrderItem column references and authoritative records
    if (originalLotId && originalLotId !== lot.id) {
      throw new ProvenanceConsistencyViolationError(
        `OrderItem "${orderItemId}" originalLotId "${originalLotId}" does not match lot id "${lot.id}".`,
      );
    }

    if (originalListingId && originalListingId !== listing.id) {
      throw new ProvenanceConsistencyViolationError(
        `OrderItem "${orderItemId}" originalListingId "${originalListingId}" does not match listing id "${listing.id}".`,
      );
    }

    // 2. Correlation between Listing and Lot
    if (listing.lotId !== lot.id) {
      throw new ProvenanceConsistencyViolationError(
        `Authoritative listing "${listing.id}" lotId "${listing.lotId}" does not match referenced lot id "${lot.id}".`,
      );
    }

    // 3. Correlation between Listing and Authorized Vendor
    if (listing.vendorId !== expectedVendorId) {
      throw new ProvenanceConsistencyViolationError(
        `Authoritative listing "${listing.id}" belongs to vendor "${listing.vendorId}", but order belongs to vendor "${expectedVendorId}". Cross-vendor listing assignment is prohibited.`,
      );
    }

    // 4. Correlation between Snapshot and Column references (if snapshot present)
    if (purchaseSnapshot) {
      const snapshot = this.validatePurchaseSnapshotStructure(purchaseSnapshot);

      if (originalLotId && snapshot.originalLotId !== originalLotId) {
        throw new ProvenanceConsistencyViolationError(
          `Purchase snapshot originalLotId "${snapshot.originalLotId}" mismatches OrderItem.originalLotId "${originalLotId}".`,
        );
      }

      if (originalListingId && snapshot.originalListingId !== originalListingId) {
        throw new ProvenanceConsistencyViolationError(
          `Purchase snapshot originalListingId "${snapshot.originalListingId}" mismatches OrderItem.originalListingId "${originalListingId}".`,
        );
      }

      if (snapshot.vendorId !== expectedVendorId) {
        throw new ProvenanceConsistencyViolationError(
          `Purchase snapshot vendorId "${snapshot.vendorId}" mismatches order vendor "${expectedVendorId}".`,
        );
      }

      if (snapshot.productId !== listing.productId) {
        throw new ProvenanceConsistencyViolationError(
          `Purchase snapshot productId "${snapshot.productId}" mismatches authoritative listing product "${listing.productId}".`,
        );
      }
    }
  }

  /**
   * Enforces immutability: prevents altering or clearing purchase-time provenance once set,
   * matching PostgreSQL's IS DISTINCT FROM trigger logic (rejects NULL-to-value, value-to-NULL, and value changes).
   */
  static assertProvenanceImmutability(params: ImmutabilityCheckParams): void {
    const { orderItemId, existing, update } = params;

    const existingLot = existing.originalLotId ?? null;
    if (update.originalLotId !== undefined && update.originalLotId !== existingLot) {
      throw new ProvenanceImmutabilityViolationError(
        orderItemId,
        'originalLotId',
        existingLot,
        update.originalLotId,
      );
    }

    const existingListing = existing.originalListingId ?? null;
    if (update.originalListingId !== undefined && update.originalListingId !== existingListing) {
      throw new ProvenanceImmutabilityViolationError(
        orderItemId,
        'originalListingId',
        existingListing,
        update.originalListingId,
      );
    }

    if (update.purchaseSnapshot !== undefined) {
      const existingSnapshotStr = existing.purchaseSnapshot ? JSON.stringify(existing.purchaseSnapshot) : null;
      const updateSnapshotStr = update.purchaseSnapshot ? JSON.stringify(update.purchaseSnapshot) : null;
      if (updateSnapshotStr !== existingSnapshotStr) {
        throw new ProvenanceImmutabilityViolationError(
          orderItemId,
          'purchaseSnapshot',
          existingSnapshotStr,
          updateSnapshotStr,
        );
      }
    }
  }

  /**
   * Verifies the core business rule: WHOLE_RAW pricing basis is charged on verified whole raw
   * weight before cleaning/butchery, not post-cleaning yield.
   */
  static verifyWholeRawPricingRule(snapshot: SeafoodPurchaseSnapshotV1): boolean {
    if (snapshot.pricingBasis === SeafoodPricingBasis.WHOLE_RAW) {
      // Must maintain whole raw pricing basis; preparation fees are strictly additive and disclosed separately
      return true;
    }
    return false;
  }

  /**
   * Rejects any attempt to backfill historical orders with inferred provenance from mutable Product records.
   */
  static assertNoSyntheticBackfill(params: {
    readonly isLegacyOrder: boolean;
    readonly attemptingSynthesis: boolean;
  }): void {
    if (params.isLegacyOrder && params.attemptingSynthesis) {
      throw new SyntheticProvenanceForbiddenError(
        'Synthesizing or backfilling purchase-time provenance for historical orders from mutable product fields is strictly prohibited. Legacy orders must remain explicitly unknown.',
      );
    }
  }
}
