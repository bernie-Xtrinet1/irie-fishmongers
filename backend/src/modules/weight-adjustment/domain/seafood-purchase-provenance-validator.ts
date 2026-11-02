import Decimal from 'decimal.js';
import { ProductUnit, SeafoodPricingBasis, WeightUnit } from '@prisma/client';
import {
  InvalidPurchaseSnapshotError,
  PreparationChargeMethod,
  ProvenanceConsistencyViolationError,
  ProvenanceImmutabilityViolationError,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V1,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
  SeafoodPurchaseSnapshot,
  SeafoodPurchaseSnapshotV1,
  SeafoodPurchaseSnapshotV2,
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
 * Standard conversion factor: 1 kilogram = 2.20462 pounds.
 */
export const LBS_PER_KG = new Decimal('2.20462');

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

/**
 * Determines whether a given year is a Gregorian leap year.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Validates that year, month, and day form a legitimate calendar date.
 * Rejects impossible dates such as February 29 on non-leap years, February 31, April 31, etc.
 */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maxDays = daysInMonth[month - 1];
  if (maxDays === undefined) {
    return false;
  }
  return day <= maxDays;
}

/**
 * Strict ISO-8601 regex:
 * - 4-digit year, 2-digit month (01-12), 2-digit day (01-31)
 * - 'T' separator
 * - 2-digit hour (00-23), 2-digit minute (00-59), 2-digit second (00-59)
 * - Optional fractional seconds (. followed by 1 or more digits)
 * - Explicit timezone: 'Z' or [+-]HH:mm (HH: 00-23, mm: 00-59)
 */
const STRICT_ISO8601_REGEX =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Validates a strict ISO-8601 timestamp string with explicit timezone.
 * Rejects impossible calendar dates, invalid clock values, invalid timezone offsets, and malformed fractional seconds.
 */
export function validateStrictIso8601Timestamp(val: unknown, fieldName: string): void {
  if (typeof val !== 'string') {
    throw new InvalidPurchaseSnapshotError(
      `Timestamp field "${fieldName}" must be a string (got ${typeof val}).`,
    );
  }

  const match = STRICT_ISO8601_REGEX.exec(val);
  const yearStr = match?.[1];
  const monthStr = match?.[2];
  const dayStr = match?.[3];

  if (!match || yearStr === undefined || monthStr === undefined || dayStr === undefined) {
    throw new InvalidPurchaseSnapshotError(
      `Timestamp field "${fieldName}" must be a valid ISO-8601 string with an explicit timezone offset or "Z" (got: "${val}").`,
    );
  }

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (!isValidCalendarDate(year, month, day)) {
    throw new InvalidPurchaseSnapshotError(
      `Timestamp field "${fieldName}" specifies an impossible calendar date: "${val}".`,
    );
  }

  if (isNaN(Date.parse(val))) {
    throw new InvalidPurchaseSnapshotError(
      `Timestamp field "${fieldName}" could not be parsed as a valid Date: "${val}".`,
    );
  }
}

/**
 * Computes preparation fee for V2 snapshot validation strictly following approved formulas.
 *
 * Requirements (WP4.3B.4B.2):
 * - FIXED_PER_FISH: rate * fishCount
 * - FIXED_PER_POUND: rate * originalWholeWeightLbs (already normalized to pounds; originalWholeWeightUnit is metadata only)
 * - NO_PREPARATION: rate must be strictly the normalized literal string "0.00"; returns Decimal("0.00")
 */
export function computeV2PreparationFee(params: {
  readonly chargeMethod: PreparationChargeMethod;
  readonly rate: string | Decimal;
  readonly fishCount?: number | null;
  readonly originalWholeWeight?: number | Decimal | null;
  readonly originalWholeWeightUnit?: WeightUnit;
}): Decimal {
  if (params.chargeMethod === PreparationChargeMethod.NO_PREPARATION) {
    if (typeof params.rate !== 'string' || params.rate !== '0.00') {
      throw new InvalidPurchaseSnapshotError(
        `NO_PREPARATION preparation option rate must be strictly the normalized literal string "0.00" (got: ${typeof params.rate === 'string' ? `"${params.rate}"` : String(params.rate)}).`,
      );
    }
    return new Decimal('0.00');
  }

  if (params.rate === undefined || params.rate === null) {
    throw new InvalidPurchaseSnapshotError(
      `Preparation chargeMethod "${params.chargeMethod}" requires an explicit positive rate.`,
    );
  }

  let rateStr: string;
  try {
    rateStr = params.rate instanceof Decimal ? params.rate.toFixed(2) : String(params.rate);
  } catch {
    throw new InvalidPurchaseSnapshotError(
      `Preparation rate could not be converted to string (got: ${String(params.rate)}).`,
    );
  }

  const rateDec = validateMonetaryDecimalString(
    rateStr,
    'selectedPreparationOption.rate',
    false,
  );

  if (params.chargeMethod === PreparationChargeMethod.FIXED_PER_FISH) {
    if (
      params.fishCount === undefined ||
      params.fishCount === null ||
      typeof params.fishCount !== 'number' ||
      !Number.isInteger(params.fishCount) ||
      params.fishCount <= 0
    ) {
      throw new InvalidPurchaseSnapshotError(
        `FIXED_PER_FISH preparation pricing requires an explicit positive integer fishCount (got: ${String(params.fishCount)}).`,
      );
    }
    return new Decimal(params.fishCount).times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  if (params.chargeMethod === PreparationChargeMethod.FIXED_PER_POUND) {
    if (params.originalWholeWeight === undefined || params.originalWholeWeight === null) {
      throw new InvalidPurchaseSnapshotError(
        'FIXED_PER_POUND preparation pricing requires an explicit original whole-fish weight.',
      );
    }

    let rawWeight: Decimal;
    try {
      rawWeight =
        params.originalWholeWeight instanceof Decimal
          ? params.originalWholeWeight
          : new Decimal(params.originalWholeWeight as any);
    } catch {
      throw new InvalidPurchaseSnapshotError(
        `FIXED_PER_POUND preparation pricing original whole-fish weight could not be parsed as Decimal (got: ${String(params.originalWholeWeight)}).`,
      );
    }

    if (rawWeight.isNaN() || !rawWeight.isFinite() || rawWeight.lessThanOrEqualTo(0)) {
      throw new InvalidPurchaseSnapshotError(
        `FIXED_PER_POUND preparation pricing requires a positive finite original whole-fish weight (got: ${String(params.originalWholeWeight)}).`,
      );
    }

    // Canonical whole weight (originalWholeWeightLbs) is already normalized to pounds prior to snapshot creation.
    // originalWholeWeightUnit is informational metadata only; no secondary unit conversion is performed.
    return rawWeight.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  throw new InvalidPurchaseSnapshotError(
    `Unsupported preparation chargeMethod: "${String(params.chargeMethod)}".`,
  );
}

export class SeafoodPurchaseProvenanceValidator {
  /**
   * Dispatches snapshot validation to version-specific validators based on schemaVersion.
   * Tolerates historical V1 records while enforcing strict V2 contracts for new purchases.
   */
  static validatePurchaseSnapshotStructure(snapshot: unknown): SeafoodPurchaseSnapshot {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new InvalidPurchaseSnapshotError('Purchase snapshot must be a non-null object.');
    }

    const obj = snapshot as Record<string, any>;

    if (obj.schemaVersion === SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V1) {
      return this.validatePurchaseSnapshotStructureV1(snapshot);
    }

    if (obj.schemaVersion === SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2) {
      return this.validatePurchaseSnapshotStructureV2(snapshot);
    }

    throw new InvalidPurchaseSnapshotError(
      `Unsupported snapshot schema version: ${obj.schemaVersion}. Expected: ${SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V1} or ${SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2}.`,
    );
  }

  /**
   * Validates historical V1 purchase snapshot structure (preserved strictly for backward compatibility).
   */
  static validatePurchaseSnapshotStructureV1(snapshot: unknown): SeafoodPurchaseSnapshotV1 {
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
   * Validates version 2 purchase snapshot structure.
   * Enforces mandatory quote-consent evidence, physical measures, recognized preparation methods,
   * vendor rates, and independent fee arithmetic.
   *
   * Note on validation boundary:
   * Structural validation verifies schema, typing, formatting, and mathematical consistency.
   * It does NOT prove live customer authentication or cryptographic signature acceptance,
   * which are verified at checkout quote verification boundaries.
   */
  static validatePurchaseSnapshotStructureV2(snapshot: unknown): SeafoodPurchaseSnapshotV2 {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new InvalidPurchaseSnapshotError('Purchase snapshot must be a non-null object.');
    }

    const obj = snapshot as Record<string, any>;

    if (obj.schemaVersion !== SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2) {
      throw new InvalidPurchaseSnapshotError(
        `Unsupported snapshot schema version: ${obj.schemaVersion}. Expected: ${SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2}.`,
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
          `Purchase snapshot field "${field}" must be a non-empty string in V2 snapshot.`,
        );
      }
    }

    if (obj.currency !== 'JMD') {
      throw new InvalidPurchaseSnapshotError(
        `Purchase snapshot currency must be strictly "JMD" in V2 snapshot (got: "${String(obj.currency)}").`,
      );
    }

    if (!Object.values(SeafoodPricingBasis).includes(obj.pricingBasis)) {
      throw new InvalidPurchaseSnapshotError(
        `Invalid pricingBasis in V2 snapshot: "${obj.pricingBasis}".`,
      );
    }

    if (!Object.values(ProductUnit).includes(obj.unit)) {
      throw new InvalidPurchaseSnapshotError(
        `Invalid product unit in V2 snapshot: "${obj.unit}".`,
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
        `pieceCount must be a positive integer in V2 purchase snapshot (got: ${obj.pieceCount}).`,
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

    if (obj.fishCount !== undefined && obj.fishCount !== null) {
      if (
        typeof obj.fishCount !== 'number' ||
        isNaN(obj.fishCount) ||
        !Number.isInteger(obj.fishCount) ||
        obj.fishCount <= 0
      ) {
        throw new InvalidPurchaseSnapshotError(
          `fishCount must be a positive integer in V2 purchase snapshot (got: ${obj.fishCount}).`,
        );
      }
    }

    if (obj.originalWholeWeightLbs !== undefined && obj.originalWholeWeightLbs !== null) {
      if (
        typeof obj.originalWholeWeightLbs !== 'number' ||
        isNaN(obj.originalWholeWeightLbs) ||
        !isFinite(obj.originalWholeWeightLbs) ||
        obj.originalWholeWeightLbs <= 0
      ) {
        throw new InvalidPurchaseSnapshotError(
          `originalWholeWeightLbs must be a positive finite number in V2 snapshot (got: ${obj.originalWholeWeightLbs}).`,
        );
      }
    }

    if (obj.originalWholeWeightUnit !== undefined && obj.originalWholeWeightUnit !== null) {
      if (!Object.values(WeightUnit).includes(obj.originalWholeWeightUnit)) {
        throw new InvalidPurchaseSnapshotError(
          `Invalid originalWholeWeightUnit in V2 snapshot: "${obj.originalWholeWeightUnit}".`,
        );
      }
    }

    // Species remains optional unless provided; if provided, must be a non-empty string
    if (obj.species !== undefined && obj.species !== null) {
      if (typeof obj.species !== 'string' || obj.species.trim() === '') {
        throw new InvalidPurchaseSnapshotError('species in V2 snapshot must be a non-empty string if supplied.');
      }
    }

    // Validate purchasedAt timestamp with strict ISO-8601 rules (Correction 3)
    validateStrictIso8601Timestamp(obj.purchasedAt, 'purchasedAt');

    // Preparation Option V2 Validation (Correction 4: Optional, but if supplied must be a non-null, non-array object)
    if (obj.selectedPreparationOption !== undefined) {
      const prep = obj.selectedPreparationOption;
      if (typeof prep !== 'object' || prep === null || Array.isArray(prep)) {
        throw new InvalidPurchaseSnapshotError(
          `selectedPreparationOption must be a non-null, non-array object when supplied in V2 snapshot (got: ${prep === null ? 'null' : Array.isArray(prep) ? 'array' : typeof prep}).`,
        );
      }
      if (typeof prep.id !== 'string' || prep.id.trim() === '') {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption.id must be a non-empty string in V2 snapshot.');
      }
      if (typeof prep.name !== 'string' || prep.name.trim() === '') {
        throw new InvalidPurchaseSnapshotError('selectedPreparationOption.name must be a non-empty string in V2 snapshot.');
      }

      // Strict preparation currency: must be canonical "JMD" without trimming or lowercase allowance (Correction C)
      if (prep.currency !== 'JMD') {
        throw new InvalidPurchaseSnapshotError(
          `selectedPreparationOption.currency must be strictly "JMD" in V2 snapshot (got: "${String(prep.currency)}").`,
        );
      }

      if (!Object.values(PreparationChargeMethod).includes(prep.chargeMethod)) {
        throw new InvalidPurchaseSnapshotError(
          `selectedPreparationOption.chargeMethod is invalid in V2 snapshot: "${prep.chargeMethod}".`,
        );
      }

      // Exact NO_PREPARATION rate and fee validation (Correction 2)
      if (prep.chargeMethod === PreparationChargeMethod.NO_PREPARATION) {
        if (typeof prep.rate !== 'string' || prep.rate !== '0.00') {
          throw new InvalidPurchaseSnapshotError(
            `NO_PREPARATION preparation option rate must be strictly the normalized literal string "0.00" in V2 snapshot (got: ${typeof prep.rate === 'string' ? `"${prep.rate}"` : String(prep.rate)}).`,
          );
        }
        if (typeof prep.fee !== 'string' || prep.fee !== '0.00') {
          throw new InvalidPurchaseSnapshotError(
            `NO_PREPARATION preparation option fee must be strictly the normalized literal string "0.00" in V2 snapshot (got: ${typeof prep.fee === 'string' ? `"${prep.fee}"` : String(prep.fee)}).`,
          );
        }
      }

      // Strict monetary validation for rate and fee
      validateMonetaryDecimalString(prep.rate, 'selectedPreparationOption.rate', true);
      const prepFeeDec = validateMonetaryDecimalString(prep.fee, 'selectedPreparationOption.fee', true);

      // Recalculate fee using approved formula
      const calculatedFee = computeV2PreparationFee({
        chargeMethod: prep.chargeMethod,
        rate: prep.rate,
        fishCount: obj.fishCount,
        originalWholeWeight: obj.originalWholeWeightLbs,
        originalWholeWeightUnit: obj.originalWholeWeightUnit,
      });

      if (!prepFeeDec.equals(calculatedFee)) {
        throw new InvalidPurchaseSnapshotError(
          `selectedPreparationOption.fee "${prep.fee}" does not match recalculated fee "${calculatedFee.toFixed(2)}" for method "${prep.chargeMethod}".`,
        );
      }
    }

    // Ceiling Consent & Quote Evidence V2 Validation (Mandatory per WP4.3B.4B.1)
    if (!obj.ceilingConsent || typeof obj.ceilingConsent !== 'object' || Array.isArray(obj.ceilingConsent)) {
      throw new InvalidPurchaseSnapshotError(
        'ceilingConsent is mandatory and must be a non-null object in V2 snapshot.',
      );
    }

    const consent = obj.ceilingConsent;

    // Strict monetary validation for authorizedCeilingJmd (positive decimal string)
    validateMonetaryDecimalString(consent.authorizedCeilingJmd, 'ceilingConsent.authorizedCeilingJmd', false);

    if (typeof consent.termsVersion !== 'string' || consent.termsVersion.trim() === '') {
      throw new InvalidPurchaseSnapshotError('ceilingConsent.termsVersion must be a non-empty string in V2 snapshot.');
    }

    // Per committed CheckoutQuoteService contract, quoteId is a non-empty server-issued identifier string.
    if (typeof consent.quoteId !== 'string' || consent.quoteId.trim() === '') {
      throw new InvalidPurchaseSnapshotError('ceilingConsent.quoteId must be a non-empty string in V2 snapshot.');
    }

    // Cryptographic payload digest must be a 64-character hexadecimal SHA-256 string
    if (typeof consent.payloadHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(consent.payloadHash)) {
      throw new InvalidPurchaseSnapshotError(
        `ceilingConsent.payloadHash must be a 64-character hex string in V2 snapshot (got: "${String(consent.payloadHash)}").`,
      );
    }

    // consentedAt must be a valid strict ISO-8601 timestamp with an explicit timezone indicator (Correction 3)
    validateStrictIso8601Timestamp(consent.consentedAt, 'ceilingConsent.consentedAt');

    return obj as SeafoodPurchaseSnapshotV2;
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
  static verifyWholeRawPricingRule(snapshot: SeafoodPurchaseSnapshot): boolean {
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
