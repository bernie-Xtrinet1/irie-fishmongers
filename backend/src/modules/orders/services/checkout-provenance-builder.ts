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
  SeafoodPurchaseSnapshotV1,
  PurchaseSnapshotPreparationOption,
  SyntheticProvenanceForbiddenError,
} from '../../weight-adjustment/domain/seafood-purchase-provenance.types';
import {
  SeafoodPurchaseProvenanceValidator,
  validateMonetaryDecimalString,
} from '../../weight-adjustment/domain/seafood-purchase-provenance-validator';
import {
  BuildProvenanceSnapshotParams,
  CeilingBelowMinimumError,
  PreparationChargeMethod,
} from '../types/checkout-provenance.types';
import {
  computeEstimatedProductSubtotal,
  computePreparationFee,
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
export function verifyWholeRawPricingRule(snapshot: SeafoodPurchaseSnapshotV1): boolean {
  return SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(snapshot);
}

/**
 * Side-effect-free provenance builder that constructs an immutable, verified
 * SeafoodPurchaseSnapshotV1 from already-resolved and authoritative source data.
 *
 * Invariants:
 * 1. Zero database or network calls.
 * 2. No inference of historical lot identity from mutable Product records.
 * 3. Exact monetary decimal-string formatting and validation.
 * 4. Preserves WHOLE_RAW, DRESSED, and FINISHED_PRODUCT pricing distinctions.
 * 5. Respects PER_POUND, PER_KILOGRAM, PER_ITEM, and PER_PACKAGE unit pricing rules (P1-03).
 * 6. Strictly requires customer ceiling JMD >= estimated item total.
 * 7. Validates cross-entity consistency with SeafoodPurchaseProvenanceValidator.
 * 8. Returns deep-frozen immutable snapshot (P2-03).
 */
export function buildProvenanceSnapshot(
  params: BuildProvenanceSnapshotParams,
): SeafoodPurchaseSnapshotV1 {
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

    // Defect B Fix: Require recognized chargeMethod and valid rate for every preparation option handled by pure provenance path
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
  // Respect PER_POUND, PER_KILOGRAM, PER_ITEM, and PER_PACKAGE unit pricing rules (P1-03)
  const estimatedProductSubtotal = computeEstimatedProductSubtotal({
    unit: params.unit,
    unitPrice: unitPriceDec,
    pieceCount: params.pieceCount,
    weight: params.estimatedWeightLbs,
    weightUnit: WeightUnit.POUNDS, // snapshot params explicitly supply estimatedWeightLbs in pounds
  });

  const estimatedItemTotal = estimatedProductSubtotal.plus(prepFeeDec);
  if (ceilingDec.lessThan(estimatedItemTotal)) {
    throw new CeilingBelowMinimumError(
      params.orderItemId,
      params.authorizedCeilingJmd,
      estimatedItemTotal.toFixed(2),
    );
  }

  // 9. Snapshot Assembly
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
