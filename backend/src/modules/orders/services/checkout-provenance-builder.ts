import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';
import {
  InvalidPurchaseSnapshotError,
  ProvenanceConsistencyViolationError,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
  SeafoodPurchaseSnapshot,
  SeafoodPurchaseSnapshotV1,
  SeafoodPurchaseSnapshotV2,
  PurchaseSnapshotPreparationOption,
  PurchaseSnapshotPreparationOptionV2,
  PurchaseSnapshotCeilingConsentV2,
  SyntheticProvenanceForbiddenError,
} from '../../weight-adjustment/domain/seafood-purchase-provenance.types';
import {
  SeafoodPurchaseProvenanceValidator,
  validateMonetaryDecimalString,
  validateStrictIso8601Timestamp,
} from '../../weight-adjustment/domain/seafood-purchase-provenance-validator';
import {
  BuildProvenanceSnapshotParams,
  BuildProvenanceSnapshotV2Params,
  CeilingBelowMinimumError,
  FinancialIntegrityError,
  PreparationChargeMethod,
  SeafoodCheckoutQuotePayload,
} from '../types/checkout-provenance.types';
import {
  canonicalJsonStringify,
  computeEstimatedProductSubtotal,
  computePreparationFee,
  LBS_PER_KG,
} from './checkout-quote.service';

/**
 * Recursively freezes an object and all nested object properties.
 * Guarantees true deep immutability for provenance snapshots (P2-03).
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Checks whether an authoritative listing is a seafood listing bound to a SeafoodLot.
 */
export function isSeafoodListing(listing: unknown): boolean {
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
    return false;
  }
  const obj = listing as Record<string, unknown>;
  return (
    typeof obj.lotId === 'string' &&
    obj.lotId.trim() !== '' &&
    typeof obj.id === 'string' &&
    obj.id.trim() !== ''
  );
}

/**
 * Prevents synthesizing purchase-time provenance for historical legacy orders.
 */
export function assertNoSyntheticProvenanceBackfill(params: {
  readonly isLegacyOrder: boolean;
  readonly attemptingSynthesis: boolean;
}): void {
  SeafoodPurchaseProvenanceValidator.assertNoSyntheticBackfill(params);
}

/**
 * Verifies whether a purchase snapshot adheres to the whole raw pricing rule.
 */
export function verifyWholeRawPricingRule(snapshot: SeafoodPurchaseSnapshot): boolean {
  return SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(snapshot);
}

/**
 * Computes the 64-character lowercase hexadecimal SHA-256 digest of a quote payload.
 * Uses deterministic alphabetical key serialization (canonicalJsonStringify).
 */
export function computeQuotePayloadHash(payload: SeafoodCheckoutQuotePayload): string {
  const canonical = canonicalJsonStringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Normalizes a weight to canonical pounds using statutory conversion (2.20462 lbs/kg)
 * and enforces PostgreSQL DECIMAL(16,8) bounds without silent truncation.
 */
export function normalizeWeightToCanonicalPounds(
  weight: Decimal | number | string,
  unit?: WeightUnit,
): Decimal {
  let dec: Decimal;
  try {
    dec = weight instanceof Decimal ? weight : new Decimal(weight);
  } catch {
    throw new FinancialIntegrityError(`Weight could not be parsed as Decimal: "${String(weight)}"`);
  }

  if (!dec.isFinite() || dec.isNaN() || dec.lte(0)) {
    throw new FinancialIntegrityError(`Weight must be a positive finite value: "${String(weight)}"`);
  }

  const lbs = unit === WeightUnit.KILOGRAMS ? dec.times(LBS_PER_KG) : dec;
  if (lbs.decimalPlaces() > 8) {
    throw new FinancialIntegrityError(
      `Normalized weight in pounds "${lbs.toString()}" cannot exceed 8 decimal places for exact lossless DECIMAL(16,8) representability.`,
    );
  }

  if (lbs.gte(100000000)) {
    throw new FinancialIntegrityError(
      `Normalized weight in pounds exceeds maximum representable limit (< 10^8): "${lbs.toString()}"`,
    );
  }

  return lbs;
}

/**
 * Constructs a version 2 purchase provenance snapshot with mandatory quote evidence,
 * vendor preparation rates, physical measures, and deep immutability.
 */
export function buildProvenanceSnapshotV2(
  params: BuildProvenanceSnapshotV2Params,
): SeafoodPurchaseSnapshotV2 {
  // 1. Mandatory Identity and Entity References
  if (!params.orderItemId || typeof params.orderItemId !== 'string') {
    throw new InvalidPurchaseSnapshotError('orderItemId must be a non-empty string.');
  }

  if (!params.listing || typeof params.listing !== 'object') {
    throw new InvalidPurchaseSnapshotError('Authoritative listing must be provided.');
  }

  if (!params.lot || typeof params.lot !== 'object') {
    throw new InvalidPurchaseSnapshotError('Authoritative lot must be provided.');
  }

  if (!params.product || typeof params.product !== 'object') {
    throw new InvalidPurchaseSnapshotError('Product entity must be provided.');
  }

  // 2. Relational Consistency Checks (Fail-closed on mismatch)
  if (params.listing.lotId !== params.lot.id) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" lotId "${params.listing.lotId}" does not match referenced lot id "${params.lot.id}".`,
    );
  }

  if (params.listing.vendorId !== params.lot.vendorId) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" vendorId "${params.listing.vendorId}" does not match lot vendor "${params.lot.vendorId}".`,
    );
  }

  if (params.listing.productId !== params.product.id) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" productId "${params.listing.productId}" does not match product id "${params.product.id}".`,
    );
  }

  // 3. Pricing Basis Validation
  if (
    params.pricingBasis !== SeafoodPricingBasis.WHOLE_RAW &&
    params.pricingBasis !== SeafoodPricingBasis.DRESSED &&
    params.pricingBasis !== SeafoodPricingBasis.FINISHED_PRODUCT
  ) {
    throw new InvalidPurchaseSnapshotError(
      `Invalid pricingBasis in snapshot: "${params.pricingBasis}". Must be WHOLE_RAW, DRESSED, or FINISHED_PRODUCT.`,
    );
  }

  // 4. Currency Validation (Strictly 'JMD')
  if (params.currency !== undefined && params.currency !== 'JMD') {
    throw new InvalidPurchaseSnapshotError(
      `Purchase snapshot currency must be "JMD" (got: "${params.currency}").`,
    );
  }

  // 5. Monetary Formatting Validation for Unit Price
  const unitPriceDec = validateMonetaryDecimalString(params.unitPrice, 'unitPrice', false);

  // Canonical Whole Weight Normalization (lossless DECIMAL(16,8) representability)
  let canonicalWholeWeightLbs: number | undefined;
  if (params.originalWholeWeightLbs !== undefined && params.originalWholeWeightLbs !== null) {
    let rawDec: Decimal;
    try {
      rawDec = new Decimal(params.originalWholeWeightLbs);
    } catch {
      throw new InvalidPurchaseSnapshotError(
        `originalWholeWeightLbs could not be parsed as Decimal (got: "${String(params.originalWholeWeightLbs)}").`,
      );
    }
    if (!rawDec.isFinite() || rawDec.isNaN() || rawDec.lte(0)) {
      throw new InvalidPurchaseSnapshotError(
        `originalWholeWeightLbs must be a positive finite value in V2 snapshot (got: ${params.originalWholeWeightLbs}).`,
      );
    }

    let normalizedDec: Decimal;
    try {
      normalizedDec = normalizeWeightToCanonicalPounds(
        rawDec,
        params.originalWholeWeightUnit ?? WeightUnit.POUNDS,
      );
    } catch (err: any) {
      throw new InvalidPurchaseSnapshotError(
        `originalWholeWeightLbs cannot be losslessly normalized to canonical pounds: ${err.message}`,
      );
    }

    const num = normalizedDec.toNumber();
    if (!new Decimal(num).equals(normalizedDec)) {
      throw new InvalidPurchaseSnapshotError(
        `Canonical weight "${normalizedDec.toString()}" cannot be losslessly represented in IEEE-754 double precision for V2 snapshot.`,
      );
    }
    canonicalWholeWeightLbs = num;
  }

  // 6. Preparation Option V2 Validation & Independent Fee Arithmetic
  let prepFeeDec = new Decimal(0);
  let prepOption: PurchaseSnapshotPreparationOptionV2 | undefined;

  if (params.selectedPreparationOption) {
    const prep = params.selectedPreparationOption;
    if (typeof prep.id !== 'string' || prep.id.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.id must be a string.');
    }
    if (typeof prep.name !== 'string' || prep.name.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.name must be a string.');
    }
    if (prep.currency !== undefined && prep.currency !== 'JMD') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.currency must be "JMD".');
    }

    if (!prep.chargeMethod || !Object.values(PreparationChargeMethod).includes(prep.chargeMethod)) {
      throw new InvalidPurchaseSnapshotError(
        `selectedPreparationOption.chargeMethod is mandatory and must be a recognized PreparationChargeMethod (got: ${String(prep.chargeMethod)}).`,
      );
    }

    if (prep.rate === undefined || prep.rate === null || typeof prep.rate !== 'string' || prep.rate.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.rate is mandatory and must be a non-empty string.');
    }

    prepFeeDec = validateMonetaryDecimalString(prep.fee, 'selectedPreparationOption.fee', true);

    const computedFee = computePreparationFee({
      chargeMethod: prep.chargeMethod,
      rate: prep.rate,
      fishCount: params.fishCount,
      originalWholeWeight: canonicalWholeWeightLbs,
      originalWholeWeightUnit: WeightUnit.POUNDS,
    });

    if (!prepFeeDec.equals(computedFee)) {
      throw new InvalidPurchaseSnapshotError(
        `selectedPreparationOption.fee "${prep.fee}" does not match computed fee "${computedFee.toFixed(2)}" for method "${prep.chargeMethod}".`,
      );
    }

    prepOption = {
      id: prep.id,
      name: prep.name,
      chargeMethod: prep.chargeMethod,
      rate: prep.rate,
      fee: prep.fee,
      currency: 'JMD',
    };
  }

  // 7. Mandatory Ceiling Consent & Quote Evidence Validation
  if (!params.quoteId || typeof params.quoteId !== 'string' || params.quoteId.trim() === '') {
    throw new InvalidPurchaseSnapshotError('ceilingConsent.quoteId must be a non-empty string in V2 snapshot.');
  }

  if (
    !params.payloadHash ||
    typeof params.payloadHash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(params.payloadHash)
  ) {
    throw new InvalidPurchaseSnapshotError(
      `ceilingConsent.payloadHash must be a 64-character hex string in V2 snapshot (got: "${String(params.payloadHash)}").`,
    );
  }

  validateStrictIso8601Timestamp(params.consentedAt, 'ceilingConsent.consentedAt');

  const ceilingDec = validateMonetaryDecimalString(
    params.authorizedCeilingJmd,
    'ceilingConsent.authorizedCeilingJmd',
    false,
  );

  if (!params.termsVersion || typeof params.termsVersion !== 'string' || params.termsVersion.trim() === '') {
    throw new InvalidPurchaseSnapshotError('ceilingConsent.termsVersion must be a non-empty string in V2 snapshot.');
  }

  // 8. Piece Count and Physical Measures Validation
  if (
    typeof params.pieceCount !== 'number' ||
    isNaN(params.pieceCount) ||
    !Number.isInteger(params.pieceCount) ||
    params.pieceCount <= 0
  ) {
    throw new InvalidPurchaseSnapshotError(
      `pieceCount must be a positive integer in purchase snapshot (got: ${params.pieceCount}).`,
    );
  }

  if (params.fishCount !== undefined && params.fishCount !== null) {
    if (
      typeof params.fishCount !== 'number' ||
      isNaN(params.fishCount) ||
      !Number.isInteger(params.fishCount) ||
      params.fishCount <= 0
    ) {
      throw new InvalidPurchaseSnapshotError(
        `fishCount must be a positive integer in V2 purchase snapshot (got: ${params.fishCount}).`,
      );
    }
  }

  if (params.estimatedWeightLbs !== undefined && params.estimatedWeightLbs !== null) {
    if (
      typeof params.estimatedWeightLbs !== 'number' ||
      isNaN(params.estimatedWeightLbs) ||
      !isFinite(params.estimatedWeightLbs) ||
      params.estimatedWeightLbs <= 0
    ) {
      throw new InvalidPurchaseSnapshotError(
        `estimatedWeightLbs must be a positive finite number (got: ${params.estimatedWeightLbs}).`,
      );
    }
  }

  // 9. Enforce Ceiling >= Estimated Item Total (Zero automatic 15% tolerance)
  const estimatedProductSubtotal = computeEstimatedProductSubtotal({
    unit: params.unit,
    unitPrice: unitPriceDec,
    pieceCount: params.pieceCount,
    weight: params.estimatedWeightLbs,
    weightUnit: WeightUnit.POUNDS,
  });

  const estimatedItemTotal = estimatedProductSubtotal.plus(prepFeeDec);
  if (ceilingDec.lessThan(estimatedItemTotal)) {
    throw new CeilingBelowMinimumError(
      params.orderItemId,
      params.authorizedCeilingJmd,
      estimatedItemTotal.toFixed(2),
    );
  }

  // 10. Assemble V2 Snapshot
  const snapshot: SeafoodPurchaseSnapshotV2 = {
    schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
    originalLotId: params.listing.lotId,
    originalListingId: params.listing.id,
    vendorId: params.listing.vendorId,
    productId: params.product.id,
    productName: params.product.name,
    productDescription: params.product.description ?? undefined,
    species: params.lot.species ?? undefined,
    pricingBasis: params.pricingBasis,
    currency: 'JMD',
    unitPrice: params.unitPrice,
    unit: params.unit,
    pieceCount: params.pieceCount,
    fishCount: params.fishCount,
    originalWholeWeightLbs: canonicalWholeWeightLbs,
    originalWholeWeightUnit: params.originalWholeWeightUnit,
    estimatedWeightLbs: params.estimatedWeightLbs,
    selectedPreparationOption: prepOption,
    usablePartsPreference: params.usablePartsPreference,
    ceilingConsent: {
      authorizedCeilingJmd: params.authorizedCeilingJmd,
      termsVersion: params.termsVersion,
      quoteId: params.quoteId,
      payloadHash: params.payloadHash.toLowerCase(),
      consentedAt: params.consentedAt,
    },
    purchasedAt: params.purchasedAt,
  };

  // 11. Pass through committed V2 structure and relational consistency validators
  SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructureV2(snapshot);
  SeafoodPurchaseProvenanceValidator.assertHybridProvenanceConsistency({
    orderItemId: params.orderItemId,
    originalLotId: snapshot.originalLotId,
    originalListingId: snapshot.originalListingId,
    purchaseSnapshot: snapshot,
    listing: params.listing,
    lot: params.lot,
    expectedVendorId: params.listing.vendorId,
  });

  // 12. Return deeply frozen snapshot (P2-03)
  return deepFreeze(snapshot);
}

/**
 * Side-effect-free provenance builder that constructs an immutable, verified
 * purchase provenance snapshot from already-resolved and authoritative source data.
 * Dispatches to V2 construction when schemaVersion = 2 is requested or when V2 quote
 * evidence is provided. Preserves 100% of historical V1 behavior otherwise.
 */
export function buildProvenanceSnapshot(
  params: BuildProvenanceSnapshotParams & { schemaVersion: 2 },
): SeafoodPurchaseSnapshotV2;
export function buildProvenanceSnapshot(
  params: BuildProvenanceSnapshotParams & { schemaVersion?: 1 },
): SeafoodPurchaseSnapshotV1;
export function buildProvenanceSnapshot(
  params: BuildProvenanceSnapshotParams,
): SeafoodPurchaseSnapshot;
export function buildProvenanceSnapshot(
  params: BuildProvenanceSnapshotParams,
): SeafoodPurchaseSnapshot {
  // If explicitly requested schemaVersion 2, build V2 snapshot
  if (params.schemaVersion === 2) {
    return buildProvenanceSnapshotV2({
      ...params,
      quoteId: params.quoteId!,
      payloadHash: params.payloadHash!,
      consentedAt: params.consentedAt!,
      selectedPreparationOption: params.selectedPreparationOption
        ? {
            id: params.selectedPreparationOption.id,
            name: params.selectedPreparationOption.name,
            chargeMethod: params.selectedPreparationOption.chargeMethod!,
            rate: params.selectedPreparationOption.rate!,
            fee: params.selectedPreparationOption.fee,
            currency: 'JMD',
          }
        : undefined,
    });
  }

  // 1. Mandatory Identity and Entity References
  if (!params.orderItemId || typeof params.orderItemId !== 'string') {
    throw new InvalidPurchaseSnapshotError('orderItemId must be a non-empty string.');
  }

  if (!params.listing || typeof params.listing !== 'object') {
    throw new InvalidPurchaseSnapshotError('Authoritative listing must be provided.');
  }

  if (!params.lot || typeof params.lot !== 'object') {
    throw new InvalidPurchaseSnapshotError('Authoritative lot must be provided.');
  }

  if (!params.product || typeof params.product !== 'object') {
    throw new InvalidPurchaseSnapshotError('Product entity must be provided.');
  }

  // 2. Relational Consistency Checks (Fail-closed on mismatch)
  if (params.listing.lotId !== params.lot.id) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" lotId "${params.listing.lotId}" does not match referenced lot id "${params.lot.id}".`,
    );
  }

  if (params.listing.vendorId !== params.lot.vendorId) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" vendorId "${params.listing.vendorId}" does not match lot vendor "${params.lot.vendorId}".`,
    );
  }

  if (params.listing.productId !== params.product.id) {
    throw new ProvenanceConsistencyViolationError(
      `Authoritative listing "${params.listing.id}" productId "${params.listing.productId}" does not match product id "${params.product.id}".`,
    );
  }

  // 3. Pricing Basis Validation
  if (
    params.pricingBasis !== SeafoodPricingBasis.WHOLE_RAW &&
    params.pricingBasis !== SeafoodPricingBasis.DRESSED &&
    params.pricingBasis !== SeafoodPricingBasis.FINISHED_PRODUCT
  ) {
    throw new InvalidPurchaseSnapshotError(
      `Invalid pricingBasis in snapshot: "${params.pricingBasis}". Must be WHOLE_RAW, DRESSED, or FINISHED_PRODUCT.`,
    );
  }

  // 4. Currency Validation (Strictly 'JMD')
  if (params.currency !== undefined && params.currency !== 'JMD') {
    throw new InvalidPurchaseSnapshotError(
      `Purchase snapshot currency must be "JMD" (got: "${params.currency}").`,
    );
  }

  // 5. Monetary Formatting Validation
  const unitPriceDec = validateMonetaryDecimalString(params.unitPrice, 'unitPrice', false);

  let prepFeeDec = new Decimal(0);
  let prepOption: PurchaseSnapshotPreparationOption | undefined;
  if (params.selectedPreparationOption) {
    const prep = params.selectedPreparationOption;
    if (typeof prep.id !== 'string' || prep.id.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.id must be a string.');
    }
    if (typeof prep.name !== 'string' || prep.name.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.name must be a string.');
    }
    prepFeeDec = validateMonetaryDecimalString(prep.fee, 'selectedPreparationOption.fee', true);

    if (prep.currency !== undefined && prep.currency !== 'JMD') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.currency must be "JMD".');
    }

    if (!prep.chargeMethod || !Object.values(PreparationChargeMethod).includes(prep.chargeMethod)) {
      throw new InvalidPurchaseSnapshotError(
        `selectedPreparationOption.chargeMethod is mandatory and must be a recognized PreparationChargeMethod (got: ${String(prep.chargeMethod)}).`,
      );
    }

    if (prep.rate === undefined || prep.rate === null || typeof prep.rate !== 'string' || prep.rate.trim() === '') {
      throw new InvalidPurchaseSnapshotError('selectedPreparationOption.rate is mandatory and must be a non-empty string.');
    }

    const computedFee = computePreparationFee({
      chargeMethod: prep.chargeMethod,
      rate: prep.rate,
      fishCount: params.fishCount,
      originalWholeWeight: params.originalWholeWeightLbs,
      originalWholeWeightUnit: params.originalWholeWeightUnit ?? WeightUnit.POUNDS,
    });

    if (!prepFeeDec.equals(computedFee)) {
      throw new InvalidPurchaseSnapshotError(
        `selectedPreparationOption.fee "${prep.fee}" does not match computed fee "${computedFee.toFixed(2)}" for method "${prep.chargeMethod}".`,
      );
    }

    prepOption = {
      id: prep.id,
      name: prep.name,
      fee: prep.fee,
      currency: 'JMD',
    };
  }

  // 6. Ceiling Consent Validation
  const ceilingDec = validateMonetaryDecimalString(
    params.authorizedCeilingJmd,
    'ceilingConsent.authorizedCeilingJmd',
    false,
  );

  if (!params.termsVersion || typeof params.termsVersion !== 'string' || params.termsVersion.trim() === '') {
    throw new InvalidPurchaseSnapshotError('ceilingConsent.termsVersion must be a non-empty string.');
  }

  // 7. Piece Count and Estimated Weight Validation
  if (
    typeof params.pieceCount !== 'number' ||
    isNaN(params.pieceCount) ||
    !Number.isInteger(params.pieceCount) ||
    params.pieceCount <= 0
  ) {
    throw new InvalidPurchaseSnapshotError(
      `pieceCount must be a positive integer in purchase snapshot (got: ${params.pieceCount}).`,
    );
  }

  if (params.estimatedWeightLbs !== undefined && params.estimatedWeightLbs !== null) {
    if (
      typeof params.estimatedWeightLbs !== 'number' ||
      isNaN(params.estimatedWeightLbs) ||
      !isFinite(params.estimatedWeightLbs) ||
      params.estimatedWeightLbs <= 0
    ) {
      throw new InvalidPurchaseSnapshotError(
        `estimatedWeightLbs must be a positive finite number (got: ${params.estimatedWeightLbs}).`,
      );
    }
  }

  // 8. Enforce Ceiling >= Estimated Item Total (Zero automatic 15% tolerance)
  const estimatedProductSubtotal = computeEstimatedProductSubtotal({
    unit: params.unit,
    unitPrice: unitPriceDec,
    pieceCount: params.pieceCount,
    weight: params.estimatedWeightLbs,
    weightUnit: WeightUnit.POUNDS,
  });

  const estimatedItemTotal = estimatedProductSubtotal.plus(prepFeeDec);
  if (ceilingDec.lessThan(estimatedItemTotal)) {
    throw new CeilingBelowMinimumError(
      params.orderItemId,
      params.authorizedCeilingJmd,
      estimatedItemTotal.toFixed(2),
    );
  }

  // 9. Snapshot Assembly (V1)
  const snapshot: SeafoodPurchaseSnapshotV1 = {
    schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
    originalLotId: params.listing.lotId,
    originalListingId: params.listing.id,
    vendorId: params.listing.vendorId,
    productId: params.product.id,
    productName: params.product.name,
    productDescription: params.product.description ?? undefined,
    species: params.lot.species,
    pricingBasis: params.pricingBasis,
    currency: 'JMD',
    unitPrice: params.unitPrice,
    unit: params.unit,
    pieceCount: params.pieceCount,
    estimatedWeightLbs: params.estimatedWeightLbs,
    selectedPreparationOption: prepOption,
    usablePartsPreference: params.usablePartsPreference,
    ceilingConsent: {
      authorizedCeilingJmd: params.authorizedCeilingJmd,
      termsVersion: params.termsVersion,
      payloadHash: params.payloadHash,
      consentedAt: params.consentedAt,
    },
    purchasedAt: params.purchasedAt,
  };

  // 10. Pass through committed schema structure and relational consistency validators
  SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(snapshot);
  SeafoodPurchaseProvenanceValidator.assertHybridProvenanceConsistency({
    orderItemId: params.orderItemId,
    originalLotId: snapshot.originalLotId,
    originalListingId: snapshot.originalListingId,
    purchaseSnapshot: snapshot,
    listing: params.listing,
    lot: params.lot,
    expectedVendorId: params.listing.vendorId,
  });

  // 11. Return deeply frozen snapshot (P2-03)
  return deepFreeze(snapshot);
}
