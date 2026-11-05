import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import { Injectable } from '@nestjs/common';
import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';
import {
  CHECKOUT_QUOTE_SCHEMA_VERSION,
  CartRevisionIntegrityError,
  CeilingBelowMinimumError,
  CheckoutQuoteError,
  FinancialIntegrityError,
  FutureQuoteError,
  InvalidQuoteSignatureError,
  IssueQuoteParams,
  MAX_ALLOWABLE_CLOCK_SKEW_MS,
  MAX_QUOTE_ITEMS_COUNT,
  MAX_QUOTE_TOKEN_BYTES,
  MAX_QUOTE_TTL_MS,
  MalformedQuoteTokenError,
  OversizedQuoteTokenError,
  PreparationChargeMethod,
  PreparationPricingError,
  QuotedPreparationOption,
  QuotedSeafoodItem,
  QuoteExpiredError,
  QuoteOwnershipMismatchError,
  SeafoodCheckoutQuotePayload,
  SignedSeafoodCheckoutQuote,
  StaleCartRevisionError,
  UnsupportedQuoteSchemaVersionError,
  VerifyQuoteOptions,
} from '../types/checkout-provenance.types';
import { validateMonetaryDecimalString } from '../../weight-adjustment/domain/seafood-purchase-provenance-validator';

/**
 * Standard conversion factor: 1 kilogram = 2.20462 pounds.
 * Matches existing domain contracts across driver settlements and database design specs.
 */
export const LBS_PER_KG = new Decimal('2.20462');

/**
 * Deterministic JSON stringifier that sorts object keys alphabetically.
 * Ensures consistent serialization regardless of property insertion order.
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }

  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();

  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );

  return `{${entries.join(',')}}`;
}

/**
 * Computes estimated product subtotal based on explicit ProductUnit pricing rules.
 * Respects PER_POUND, PER_KILOGRAM, PER_ITEM, and PER_PACKAGE distinctions.
 */
export function computeEstimatedProductSubtotal(params: {
  readonly unit: ProductUnit;
  readonly unitPrice: string | Decimal;
  readonly pieceCount: number;
  readonly weight?: number | Decimal | null;
  readonly weightUnit?: WeightUnit;
}): Decimal {
  const priceDec = params.unitPrice instanceof Decimal ? params.unitPrice : new Decimal(params.unitPrice);

  switch (params.unit) {
    case ProductUnit.PER_ITEM:
    case ProductUnit.PER_PACKAGE:
      return new Decimal(params.pieceCount).times(priceDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    case ProductUnit.PER_POUND: {
      if (params.weight === undefined || params.weight === null) {
        throw new FinancialIntegrityError(
          'ProductUnit "PER_POUND" requires an explicit physical weight. Falling back to pieceCount is prohibited.',
        );
      }
      let rawWeight: Decimal;
      try {
        rawWeight = params.weight instanceof Decimal ? params.weight : new Decimal(params.weight);
      } catch {
        throw new FinancialIntegrityError(
          `ProductUnit "PER_POUND" physical weight could not be parsed as Decimal (got: ${String(params.weight)}).`,
        );
      }
      if (rawWeight.isNaN() || !rawWeight.isFinite() || rawWeight.lessThanOrEqualTo(0)) {
        throw new FinancialIntegrityError(
          `ProductUnit "PER_POUND" requires a positive, finite physical weight (got: ${String(params.weight)}).`,
        );
      }
      const weightLbs = params.weightUnit === WeightUnit.KILOGRAMS ? rawWeight.times(LBS_PER_KG) : rawWeight;
      return weightLbs.times(priceDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    case ProductUnit.PER_KILOGRAM: {
      if (params.weight === undefined || params.weight === null) {
        throw new FinancialIntegrityError(
          'ProductUnit "PER_KILOGRAM" requires an explicit physical weight. Falling back to pieceCount is prohibited.',
        );
      }
      let rawWeight: Decimal;
      try {
        rawWeight = params.weight instanceof Decimal ? params.weight : new Decimal(params.weight);
      } catch {
        throw new FinancialIntegrityError(
          `ProductUnit "PER_KILOGRAM" physical weight could not be parsed as Decimal (got: ${String(params.weight)}).`,
        );
      }
      if (rawWeight.isNaN() || !rawWeight.isFinite() || rawWeight.lessThanOrEqualTo(0)) {
        throw new FinancialIntegrityError(
          `ProductUnit "PER_KILOGRAM" requires a positive, finite physical weight (got: ${String(params.weight)}).`,
        );
      }
      const weightKg =
        params.weightUnit === WeightUnit.POUNDS || params.weightUnit === undefined
          ? rawWeight.dividedBy(LBS_PER_KG)
          : rawWeight;
      return weightKg.times(priceDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    default:
      throw new FinancialIntegrityError(`Unsupported ProductUnit: ${String(params.unit)}`);
  }
}

/**
 * Computes preparation fee strictly following approved business rules (WP4.3B.2F.1):
 * 1. FIXED_PER_FISH: Number of fish * vendor preparation rate per fish.
 * 2. FIXED_PER_POUND: Original whole-fish weight (lb) * vendor preparation rate per pound.
 * 3. NO_PREPARATION: 0.00 JMD.
 */
export function computePreparationFee(params: {
  readonly chargeMethod: PreparationChargeMethod;
  readonly rate: string | Decimal;
  readonly fishCount?: number | null;
  readonly originalWholeWeight?: number | Decimal | string | null;
  readonly originalWholeWeightUnit?: WeightUnit;
}): Decimal {
  let rateDec: Decimal;

  if (params.rate instanceof Decimal) {
    if (!params.rate.isFinite() || params.rate.isNaN()) {
      throw new PreparationPricingError('preparationOption.rate must be a finite Decimal');
    }
    if (params.rate.lessThan(0)) {
      throw new PreparationPricingError('preparationOption.rate cannot be negative');
    }
    if (params.rate.decimalPlaces() > 2) {
      throw new PreparationPricingError(
        `preparationOption.rate cannot have more than 2 decimal places (got: ${params.rate.toString()})`,
      );
    }
    rateDec = params.rate;
  } else {
    try {
      rateDec = validateMonetaryDecimalString(
        params.rate === undefined || params.rate === null || params.rate === ''
          ? params.chargeMethod === PreparationChargeMethod.NO_PREPARATION ? '0.00' : ''
          : params.rate,
        'preparationOption.rate',
        params.chargeMethod === PreparationChargeMethod.NO_PREPARATION,
      );
    } catch (err: any) {
      throw new PreparationPricingError(err.message);
    }
  }

  if (params.chargeMethod === PreparationChargeMethod.NO_PREPARATION) {
    if (!rateDec.isZero()) {
      throw new PreparationPricingError('NO_PREPARATION must have a rate of 0.00');
    }
    return new Decimal('0.00');
  }

  if (params.chargeMethod === PreparationChargeMethod.FIXED_PER_FISH) {
    if (
      params.fishCount === undefined ||
      params.fishCount === null ||
      typeof params.fishCount !== 'number' ||
      !Number.isInteger(params.fishCount) ||
      params.fishCount <= 0
    ) {
      throw new PreparationPricingError(
        `FIXED_PER_FISH preparation pricing requires an explicit, positive integer fishCount (got: ${params.fishCount})`,
      );
    }
    return new Decimal(params.fishCount).times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  if (params.chargeMethod === PreparationChargeMethod.FIXED_PER_POUND) {
    if (params.originalWholeWeight === undefined || params.originalWholeWeight === null) {
      throw new PreparationPricingError(
        'FIXED_PER_POUND preparation pricing requires an explicit original whole-fish weight',
      );
    }

    const rawWeight =
      params.originalWholeWeight instanceof Decimal
        ? params.originalWholeWeight
        : new Decimal(params.originalWholeWeight);

    if (rawWeight.isNaN() || !rawWeight.isFinite() || rawWeight.lessThanOrEqualTo(0)) {
      throw new PreparationPricingError(
        `FIXED_PER_POUND preparation pricing requires a positive finite original whole-fish weight (got: ${params.originalWholeWeight})`,
      );
    }

    let weightLbs: Decimal;
    if (params.originalWholeWeightUnit === WeightUnit.KILOGRAMS) {
      weightLbs = rawWeight.times(LBS_PER_KG);
    } else {
      weightLbs = rawWeight;
    }

    return weightLbs.times(rateDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  throw new PreparationPricingError(`Unsupported preparation charge method: ${String(params.chargeMethod)}`);
}

/**
 * Computes a SHA-256 hash of cart item identities, quantities, and mutation versions.
 * Binds a checkout quote to an immutable snapshot of cart state.
 *
 * Invariants (SEC-01, SEC-02):
 * 1. Prohibits duplicate cart item IDs.
 * 2. Enforces positive integer quantities.
 * 3. Enforces mandatory, positive integer mutation versions (no silent fallback).
 * 4. Rejects non-canonical whitespace in identifiers.
 * 5. Preserves deterministic item ordering via sort.
 */
export function computeCartRevisionHash(
  items: Array<{
    id: string;
    productId: string;
    quantity: number;
    mutationVersion: number;
  }>,
): string {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new CartRevisionIntegrityError('Items array must be a non-empty array to compute cart revision hash');
  }

  const seenIds = new Set<string>();

  const validatedItems = items.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new CartRevisionIntegrityError(`Item at index ${index} must be an object`);
    }

    // SEC-02: Non-canonical whitespace rejection
    if (!item.id || typeof item.id !== 'string') {
      throw new CartRevisionIntegrityError(`Item at index ${index} must have a non-empty string id`);
    }
    if (item.id.trim() !== item.id || item.id === '') {
      throw new CartRevisionIntegrityError(
        `Item ID "${item.id}" is non-canonical: leading or trailing whitespace is prohibited`,
      );
    }

    if (!item.productId || typeof item.productId !== 'string') {
      throw new CartRevisionIntegrityError(`Item "${item.id}" must have a non-empty string productId`);
    }
    if (item.productId.trim() !== item.productId || item.productId === '') {
      throw new CartRevisionIntegrityError(
        `Product ID "${item.productId}" is non-canonical: leading or trailing whitespace is prohibited`,
      );
    }

    if (
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new CartRevisionIntegrityError(`Item "${item.id}" quantity must be a positive integer (got ${item.quantity})`);
    }

    // SEC-01: Mandatory mutationVersion without silent fallback
    if (
      item.mutationVersion === undefined ||
      item.mutationVersion === null ||
      typeof item.mutationVersion !== 'number' ||
      !Number.isInteger(item.mutationVersion) ||
      item.mutationVersion <= 0
    ) {
      throw new CartRevisionIntegrityError(
        `Item "${item.id}" mutationVersion is mandatory and must be a positive integer (got ${item.mutationVersion})`,
      );
    }

    if (seenIds.has(item.id)) {
      throw new CartRevisionIntegrityError(`Duplicate cart item ID "${item.id}" detected in cart revision hash calculation`);
    }
    seenIds.add(item.id);

    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      mutationVersion: item.mutationVersion,
    };
  });

  const sorted = validatedItems.sort((a, b) => a.id.localeCompare(b.id));
  const canonical = canonicalJsonStringify(sorted);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Computes the HMAC-SHA256 hex signature over the canonical JSON representation of a quote payload.
 */
export function computeQuoteSignature(payload: SeafoodCheckoutQuotePayload, secret: string): string {
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    throw new CheckoutQuoteError('A non-empty secret is required for signing quotes', 'MISSING_SECRET');
  }
  const canonical = canonicalJsonStringify(payload);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * Performs timing-safe verification of an HMAC-SHA256 signature over a quote payload.
 */
export function verifyQuoteSignature(
  payload: SeafoodCheckoutQuotePayload,
  signature: string,
  secret: string,
): boolean {
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    throw new CheckoutQuoteError('A non-empty secret is required for verifying quote signatures', 'MISSING_SECRET');
  }
  if (!signature || typeof signature !== 'string') {
    return false;
  }
  // HMAC-SHA256 hex string must be exactly 64 hexadecimal characters
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) {
    return false;
  }

  const expectedSig = computeQuoteSignature(payload, secret);
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Validates full structural and financial integrity of a quote payload at runtime.
 * Never relies solely on TypeScript compile-time interfaces (P1-01, P1-02, SEC-03, SEC-04).
 */
export function validateQuotePayloadStructure(payload: unknown): SeafoodCheckoutQuotePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MalformedQuoteTokenError('Quote payload must be a non-null object');
  }

  const p = payload as Record<string, any>;

  // 1. Schema version
  if (p.schemaVersion !== CHECKOUT_QUOTE_SCHEMA_VERSION) {
    throw new UnsupportedQuoteSchemaVersionError(p.schemaVersion);
  }

  // 2. String identifier fields
  const requiredStringFields = [
    'quoteId',
    'authenticatedCustomerId',
    'cartId',
    'cartRevisionHash',
    'termsVersion',
    'issuedAt',
    'expiresAt',
  ];
  for (const field of requiredStringFields) {
    if (typeof p[field] !== 'string' || p[field].trim() === '') {
      throw new MalformedQuoteTokenError(`Payload field "${field}" must be a non-empty string`);
    }
  }

  // 3. Cart revision hash format
  if (!/^[0-9a-fA-F]{64}$/.test(p.cartRevisionHash)) {
    throw new MalformedQuoteTokenError(
      `cartRevisionHash must be a 64-character SHA-256 hexadecimal string (got "${p.cartRevisionHash}")`,
    );
  }

  // 4. Timestamps
  const issuedDate = new Date(p.issuedAt);
  if (isNaN(issuedDate.getTime())) {
    throw new MalformedQuoteTokenError(`Payload issuedAt "${p.issuedAt}" is not a valid ISO 8601 timestamp`);
  }
  const expiresDate = new Date(p.expiresAt);
  if (isNaN(expiresDate.getTime())) {
    throw new MalformedQuoteTokenError(`Payload expiresAt "${p.expiresAt}" is not a valid ISO 8601 timestamp`);
  }
  if (expiresDate.getTime() <= issuedDate.getTime()) {
    throw new MalformedQuoteTokenError(
      `expiresAt ("${p.expiresAt}") must be strictly after issuedAt ("${p.issuedAt}")`,
    );
  }
  const validityDuration = expiresDate.getTime() - issuedDate.getTime();
  if (validityDuration > MAX_QUOTE_TTL_MS) {
    throw new MalformedQuoteTokenError(
      `Quote TTL (${validityDuration}ms) exceeds maximum allowable validity of ${MAX_QUOTE_TTL_MS}ms (15 minutes)`,
    );
  }

  // 5. Items array and bounds (SEC-05)
  if (!Array.isArray(p.items) || p.items.length === 0) {
    throw new MalformedQuoteTokenError('Quote payload items must be a non-empty array');
  }
  if (p.items.length > MAX_QUOTE_ITEMS_COUNT) {
    throw new OversizedQuoteTokenError(
      `Quote items count (${p.items.length}) exceeds maximum limit (${MAX_QUOTE_ITEMS_COUNT})`,
    );
  }

  let accumulatedSeafoodTotal = new Decimal(0);
  let accumulatedCustomerCeilings = new Decimal(0);
  const seenCartItemIds = new Set<string>();

  for (let i = 0; i < p.items.length; i++) {
    const item = p.items[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new MalformedQuoteTokenError(`Item at index ${i} must be an object`);
    }

    const itemRequiredStrings = [
      'cartItemId',
      'productId',
      'listingId',
      'lotId',
      'vendorId',
      'species',
      'productTitle',
      'unitPrice',
      'estimatedProductSubtotal',
      'estimatedPreparationFee',
      'estimatedItemTotal',
      'minimumAuthorizedCeilingJmd',
      'customerAuthorizedCeilingJmd',
    ];
    for (const field of itemRequiredStrings) {
      if (typeof item[field] !== 'string' || item[field].trim() === '') {
        throw new MalformedQuoteTokenError(`Item at index ${i} missing required string field "${field}"`);
      }
    }

    // SEC: Each line item must have an unambiguous, unique cartItemId and deterministic order
    if (seenCartItemIds.has(item.cartItemId)) {
      throw new MalformedQuoteTokenError(
        `Duplicate cart item ID "${item.cartItemId}" detected in quote payload items`,
      );
    }
    seenCartItemIds.add(item.cartItemId);

    if (i > 0 && p.items[i - 1].cartItemId.localeCompare(item.cartItemId) > 0) {
      throw new MalformedQuoteTokenError(
        `Items array must be deterministically sorted by cartItemId (found "${p.items[i - 1].cartItemId}" before "${item.cartItemId}")`,
      );
    }

    // Integers and numbers
    if (typeof item.mutationVersion !== 'number' || !Number.isInteger(item.mutationVersion) || item.mutationVersion <= 0) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" mutationVersion must be a positive integer`);
    }
    if (typeof item.pieceCount !== 'number' || !Number.isInteger(item.pieceCount) || item.pieceCount <= 0) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" pieceCount must be a positive integer`);
    }
    if (
      typeof item.estimatedBillableWeight !== 'number' ||
      !Number.isFinite(item.estimatedBillableWeight) ||
      item.estimatedBillableWeight <= 0
    ) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" estimatedBillableWeight must be a positive finite number`);
    }

    // Enums
    if (!Object.values(SeafoodPricingBasis).includes(item.pricingBasis)) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" has invalid pricingBasis "${item.pricingBasis}"`);
    }
    if (!Object.values(ProductUnit).includes(item.unit)) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" has invalid unit "${item.unit}"`);
    }
    if (!Object.values(WeightUnit).includes(item.weightUnit)) {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" has invalid weightUnit "${item.weightUnit}"`);
    }
    if (item.currency !== 'JMD') {
      throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" currency must be "JMD" (got "${item.currency}")`);
    }
    if (!Object.values(UsablePartsPreference).includes(item.usablePartsPreference)) {
      throw new MalformedQuoteTokenError(
        `Item "${item.cartItemId}" has invalid usablePartsPreference "${item.usablePartsPreference}"`,
      );
    }

    // SEC-04: Preparation option & fee calculation verification
    let calculatedPrepFee = new Decimal('0.00');
    if (item.selectedPreparationOption) {
      const prep = item.selectedPreparationOption;
      if (typeof prep !== 'object' || prep === null) {
        throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" selectedPreparationOption must be an object`);
      }
      if (typeof prep.id !== 'string' || prep.id.trim() === '') {
        throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" selectedPreparationOption.id must be a string`);
      }
      if (typeof prep.name !== 'string' || prep.name.trim() === '') {
        throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" selectedPreparationOption.name must be a string`);
      }
      if (!Object.values(PreparationChargeMethod).includes(prep.chargeMethod)) {
        throw new MalformedQuoteTokenError(
          `Item "${item.cartItemId}" selectedPreparationOption has invalid chargeMethod "${prep.chargeMethod}"`,
        );
      }
      if (typeof prep.rate !== 'string' || prep.rate.trim() === '') {
        throw new MalformedQuoteTokenError(`Item "${item.cartItemId}" selectedPreparationOption.rate must be a string`);
      }
      if (prep.currency !== 'JMD') {
        throw new MalformedQuoteTokenError(
          `Item "${item.cartItemId}" selectedPreparationOption currency must be "JMD" (got "${prep.currency}")`,
        );
      }

      // Independently compute preparation fee from approved formulas
      calculatedPrepFee = computePreparationFee({
        chargeMethod: prep.chargeMethod,
        rate: prep.rate,
        fishCount: item.fishCount,
        originalWholeWeight: item.originalWholeWeightLbs,
        originalWholeWeightUnit: item.originalWholeWeightUnit ?? item.weightUnit,
      });

      const prepFeeReportedDec = validateMonetaryDecimalString(prep.fee, `items[${i}].selectedPreparationOption.fee`, true);
      if (!prepFeeReportedDec.equals(calculatedPrepFee)) {
        throw new FinancialIntegrityError(
          `Item "${item.cartItemId}" preparation fee reported (${prepFeeReportedDec.toFixed(2)}) does not match calculated preparation fee (${calculatedPrepFee.toFixed(2)}) for method ${prep.chargeMethod}`,
        );
      }
    }

    // Financial decimal validation
    const unitPriceDec = validateMonetaryDecimalString(item.unitPrice, `items[${i}].unitPrice`, false);
    const subtotalDec = validateMonetaryDecimalString(
      item.estimatedProductSubtotal,
      `items[${i}].estimatedProductSubtotal`,
      true,
    );
    const itemPrepFeeDec = validateMonetaryDecimalString(
      item.estimatedPreparationFee,
      `items[${i}].estimatedPreparationFee`,
      true,
    );
    const itemTotalDec = validateMonetaryDecimalString(item.estimatedItemTotal, `items[${i}].estimatedItemTotal`, true);
    const minCeilingDec = validateMonetaryDecimalString(
      item.minimumAuthorizedCeilingJmd,
      `items[${i}].minimumAuthorizedCeilingJmd`,
      true,
    );
    const custCeilingDec = validateMonetaryDecimalString(
      item.customerAuthorizedCeilingJmd,
      `items[${i}].customerAuthorizedCeilingJmd`,
      false,
    );

    // Preparation fee consistency
    if (!itemPrepFeeDec.equals(calculatedPrepFee)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedPreparationFee (${itemPrepFeeDec.toFixed(2)}) does not match preparation calculation (${calculatedPrepFee.toFixed(2)})`,
      );
    }

    // Financial integrity check 1: Estimated item total equals product subtotal plus preparation fee
    const expectedItemTotal = subtotalDec.plus(calculatedPrepFee);
    if (!itemTotalDec.equals(expectedItemTotal)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedItemTotal (${itemTotalDec.toFixed(2)}) does not equal product subtotal (${subtotalDec.toFixed(2)}) + preparation fee (${calculatedPrepFee.toFixed(2)})`,
      );
    }

    // Financial integrity check 2: Product subtotal equals formula calculation
    const expectedSubtotal = computeEstimatedProductSubtotal({
      unit: item.unit,
      unitPrice: unitPriceDec,
      pieceCount: item.pieceCount,
      weight: item.estimatedBillableWeight,
      weightUnit: item.weightUnit,
    });
    if (!subtotalDec.equals(expectedSubtotal)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedProductSubtotal (${subtotalDec.toFixed(2)}) does not match unit-based calculation (${expectedSubtotal.toFixed(2)}) for unit ${item.unit}`,
      );
    }

    // Financial integrity check 3: Customer ceiling must be >= item total and >= minimum ceiling
    if (custCeilingDec.lessThan(itemTotalDec)) {
      throw new CeilingBelowMinimumError(item.cartItemId, item.customerAuthorizedCeilingJmd, item.estimatedItemTotal);
    }
    if (custCeilingDec.lessThan(minCeilingDec)) {
      throw new CeilingBelowMinimumError(
        item.cartItemId,
        item.customerAuthorizedCeilingJmd,
        item.minimumAuthorizedCeilingJmd,
      );
    }

    accumulatedSeafoodTotal = accumulatedSeafoodTotal.plus(itemTotalDec);
    accumulatedCustomerCeilings = accumulatedCustomerCeilings.plus(custCeilingDec);
  }

  // 6. Order-level monetary validation & balance checks
  const seafoodSubtotalDec = validateMonetaryDecimalString(
    p.estimatedSeafoodSubtotalJmd,
    'estimatedSeafoodSubtotalJmd',
    true,
  );
  if (!seafoodSubtotalDec.equals(accumulatedSeafoodTotal)) {
    throw new FinancialIntegrityError(
      `estimatedSeafoodSubtotalJmd (${seafoodSubtotalDec.toFixed(2)}) does not equal sum of item totals (${accumulatedSeafoodTotal.toFixed(2)})`,
    );
  }

  const nonSeafoodSubtotalDec = validateMonetaryDecimalString(p.nonSeafoodSubtotalJmd, 'nonSeafoodSubtotalJmd', true);
  const deliveryChargeDec = validateMonetaryDecimalString(p.deliveryChargeJmd, 'deliveryChargeJmd', true);
  const taxAmountDec = validateMonetaryDecimalString(p.taxAmountJmd, 'taxAmountJmd', true);

  const expectedOrderTotal = seafoodSubtotalDec
    .plus(nonSeafoodSubtotalDec)
    .plus(deliveryChargeDec)
    .plus(taxAmountDec);
  const orderTotalDec = validateMonetaryDecimalString(
    p.completeEstimatedOrderTotalJmd,
    'completeEstimatedOrderTotalJmd',
    true,
  );
  if (!orderTotalDec.equals(expectedOrderTotal)) {
    throw new FinancialIntegrityError(
      `completeEstimatedOrderTotalJmd (${orderTotalDec.toFixed(2)}) does not equal sum of applicable charges (${expectedOrderTotal.toFixed(2)})`,
    );
  }

  const expectedOrderCeiling = accumulatedCustomerCeilings
    .plus(nonSeafoodSubtotalDec)
    .plus(deliveryChargeDec)
    .plus(taxAmountDec);
  const orderCeilingDec = validateMonetaryDecimalString(
    p.completeOrderAuthorizedCeilingJmd,
    'completeOrderAuthorizedCeilingJmd',
    false,
  );
  if (!orderCeilingDec.equals(expectedOrderCeiling)) {
    throw new FinancialIntegrityError(
      `completeOrderAuthorizedCeilingJmd (${orderCeilingDec.toFixed(2)}) does not equal sum of customer authorized ceilings and non-seafood charges (${expectedOrderCeiling.toFixed(2)})`,
    );
  }

  return p as SeafoodCheckoutQuotePayload;
}

/**
 * Serializes a signed quote into a URL-safe base64 token.
 */
export function encodeQuoteToken(signedQuote: SignedSeafoodCheckoutQuote): string {
  if (!signedQuote || !signedQuote.payload || !signedQuote.signature) {
    throw new MalformedQuoteTokenError('Invalid signed quote structure for token encoding');
  }
  const json = canonicalJsonStringify(signedQuote);
  const token = Buffer.from(json, 'utf8').toString('base64url');
  if (Buffer.byteLength(token, 'utf8') > MAX_QUOTE_TOKEN_BYTES) {
    throw new OversizedQuoteTokenError(Buffer.byteLength(token, 'utf8'), MAX_QUOTE_TOKEN_BYTES);
  }
  return token;
}

/**
 * Deserializes and validates a quote token string (base64url or raw JSON).
 * Rejects oversized or malformed tokens fail-closed.
 */
export function decodeQuoteToken(token: string): SignedSeafoodCheckoutQuote {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new MalformedQuoteTokenError('Token is empty or not a string');
  }

  const byteLength = Buffer.byteLength(token, 'utf8');
  if (byteLength > MAX_QUOTE_TOKEN_BYTES) {
    throw new OversizedQuoteTokenError(byteLength, MAX_QUOTE_TOKEN_BYTES);
  }

  let rawJson: string;
  try {
    const trimmed = token.trim();
    if (trimmed.startsWith('{')) {
      rawJson = trimmed;
    } else {
      rawJson = Buffer.from(trimmed, 'base64url').toString('utf8');
    }
  } catch (err: any) {
    throw new MalformedQuoteTokenError(`Base64 decoding failed: ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: any) {
    throw new MalformedQuoteTokenError(`JSON parsing failed: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedQuoteTokenError('Decoded token must be an object');
  }

  const obj = parsed as Record<string, any>;
  if (!obj.payload || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
    throw new MalformedQuoteTokenError('Decoded token is missing a valid payload object');
  }

  if (typeof obj.signature !== 'string' || obj.signature.trim() === '') {
    throw new MalformedQuoteTokenError('Decoded token is missing a valid signature string');
  }

  return {
    payload: obj.payload as SeafoodCheckoutQuotePayload,
    signature: obj.signature,
  };
}

/**
 * Issues an immutable, cryptographically signed seafood checkout quote.
 * Validates all item monetary amounts, preparation pricing, customer ceilings, and order-level totals.
 *
 * Invariants (P1-02, P2-02, SEC-03, SEC-04):
 * 1. Pre-validates complete structure and financial equations BEFORE signing.
 * 2. TTL cannot exceed 15 minutes.
 * 3. Exact JMD decimal precision enforced.
 */
export function issueQuote(params: IssueQuoteParams, secret: string): SignedSeafoodCheckoutQuote {
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    throw new CheckoutQuoteError('A non-empty secret is required to issue quotes', 'MISSING_SECRET');
  }

  if (!params.authenticatedCustomerId || typeof params.authenticatedCustomerId !== 'string') {
    throw new CheckoutQuoteError('authenticatedCustomerId is required', 'INVALID_CUSTOMER_ID');
  }

  if (!params.cartId || typeof params.cartId !== 'string') {
    throw new CheckoutQuoteError('cartId is required', 'INVALID_CART_ID');
  }

  if (!params.cartRevisionHash || typeof params.cartRevisionHash !== 'string') {
    throw new CheckoutQuoteError('cartRevisionHash is required', 'INVALID_CART_REVISION_HASH');
  }

  if (!params.termsVersion || typeof params.termsVersion !== 'string' || params.termsVersion.trim() === '') {
    throw new CheckoutQuoteError('termsVersion is required', 'INVALID_TERMS_VERSION');
  }

  if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
    throw new CheckoutQuoteError('At least one quoted seafood item is required', 'EMPTY_ITEMS');
  }

  const ttlMs = params.ttlMs ?? MAX_QUOTE_TTL_MS;
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CheckoutQuoteError('Quote TTL must be a positive finite number', 'INVALID_TTL');
  }
  if (ttlMs > MAX_QUOTE_TTL_MS) {
    throw new CheckoutQuoteError(
      `Quote TTL (${ttlMs}ms) cannot exceed maximum allowed validity of ${MAX_QUOTE_TTL_MS}ms (15 minutes)`,
      'INVALID_TTL',
    );
  }

  let seafoodEstimatedSubtotalDec = new Decimal(0);
  let seafoodCeilingSubtotalDec = new Decimal(0);

  // SEC: Validate unambiguous identity and reject duplicate cart item IDs
  const seenCartItemIds = new Set<string>();
  for (let i = 0; i < params.items.length; i++) {
    const item = params.items[i];
    if (!item.cartItemId || typeof item.cartItemId !== 'string' || item.cartItemId.trim() === '') {
      throw new MalformedQuoteTokenError(`Item at index ${i} missing required string field "cartItemId"`);
    }
    if (seenCartItemIds.has(item.cartItemId)) {
      throw new MalformedQuoteTokenError(`Duplicate cart item ID "${item.cartItemId}" detected in quote items`);
    }
    seenCartItemIds.add(item.cartItemId);
  }

  // Deterministically sort items by cartItemId to guarantee canonical stability
  const sortedInputItems = [...params.items].sort((a, b) => a.cartItemId.localeCompare(b.cartItemId));

  const validatedItems: QuotedSeafoodItem[] = sortedInputItems.map((item) => {
    // Monetary validations
    const unitPriceDec = validateMonetaryDecimalString(item.unitPrice, 'unitPrice', false);
    const itemSubtotalDec = validateMonetaryDecimalString(
      item.estimatedProductSubtotal,
      'estimatedProductSubtotal',
      true,
    );
    const prepFeeDec = validateMonetaryDecimalString(
      item.estimatedPreparationFee,
      'estimatedPreparationFee',
      true,
    );
    const itemTotalDec = validateMonetaryDecimalString(
      item.estimatedItemTotal,
      'estimatedItemTotal',
      true,
    );
    const minCeilingDec = validateMonetaryDecimalString(
      item.minimumAuthorizedCeilingJmd,
      'minimumAuthorizedCeilingJmd',
      true,
    );
    const customerCeilingDec = validateMonetaryDecimalString(
      item.customerAuthorizedCeilingJmd,
      'customerAuthorizedCeilingJmd',
      false,
    );

    // SEC-04: Preparation fee verification
    let calculatedPrepFee = new Decimal('0.00');
    if (item.selectedPreparationOption) {
      calculatedPrepFee = computePreparationFee({
        chargeMethod: item.selectedPreparationOption.chargeMethod,
        rate: item.selectedPreparationOption.rate,
        fishCount: item.fishCount,
        originalWholeWeight: item.originalWholeWeightLbs,
        originalWholeWeightUnit: item.originalWholeWeightUnit ?? item.weightUnit,
      });

      const reportedPrepFee = validateMonetaryDecimalString(
        item.selectedPreparationOption.fee,
        'selectedPreparationOption.fee',
        true,
      );
      if (!reportedPrepFee.equals(calculatedPrepFee)) {
        throw new FinancialIntegrityError(
          `Item "${item.cartItemId}" preparation fee (${reportedPrepFee.toFixed(2)}) does not match calculated preparation fee (${calculatedPrepFee.toFixed(2)})`,
        );
      }
    }

    if (!prepFeeDec.equals(calculatedPrepFee)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedPreparationFee (${prepFeeDec.toFixed(2)}) does not match calculated preparation fee (${calculatedPrepFee.toFixed(2)})`,
      );
    }

    // Financial integrity check 1: Estimated item total equals product subtotal plus preparation fee
    const expectedItemTotal = itemSubtotalDec.plus(calculatedPrepFee);
    if (!itemTotalDec.equals(expectedItemTotal)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedItemTotal (${itemTotalDec.toFixed(2)}) does not equal product subtotal (${itemSubtotalDec.toFixed(2)}) + preparation fee (${calculatedPrepFee.toFixed(2)})`,
      );
    }

    // Financial integrity check 2: Product subtotal equals formula calculation
    const expectedSubtotal = computeEstimatedProductSubtotal({
      unit: item.unit,
      unitPrice: unitPriceDec,
      pieceCount: item.pieceCount,
      weight: item.estimatedBillableWeight,
      weightUnit: item.weightUnit,
    });
    if (!itemSubtotalDec.equals(expectedSubtotal)) {
      throw new FinancialIntegrityError(
        `Item "${item.cartItemId}" estimatedProductSubtotal (${itemSubtotalDec.toFixed(2)}) does not match unit-based calculation (${expectedSubtotal.toFixed(2)}) for unit ${item.unit}`,
      );
    }

    // Enforce customer authorized ceiling cannot be less than estimated item total or minimum ceiling
    if (customerCeilingDec.lessThan(itemTotalDec)) {
      throw new CeilingBelowMinimumError(
        item.cartItemId,
        item.customerAuthorizedCeilingJmd,
        item.estimatedItemTotal,
      );
    }
    if (customerCeilingDec.lessThan(minCeilingDec)) {
      throw new CeilingBelowMinimumError(
        item.cartItemId,
        item.customerAuthorizedCeilingJmd,
        item.minimumAuthorizedCeilingJmd,
      );
    }

    seafoodEstimatedSubtotalDec = seafoodEstimatedSubtotalDec.plus(itemTotalDec);
    seafoodCeilingSubtotalDec = seafoodCeilingSubtotalDec.plus(customerCeilingDec);

    return { ...item };
  });

  const nonSeafoodSubtotalStr = params.nonSeafoodSubtotalJmd ?? '0.00';
  const nonSeafoodSubtotalDec = validateMonetaryDecimalString(
    nonSeafoodSubtotalStr,
    'nonSeafoodSubtotalJmd',
    true,
  );

  const deliveryChargeStr = params.deliveryChargeJmd ?? '0.00';
  const deliveryChargeDec = validateMonetaryDecimalString(
    deliveryChargeStr,
    'deliveryChargeJmd',
    true,
  );

  const taxAmountStr = params.taxAmountJmd ?? '0.00';
  const taxAmountDec = validateMonetaryDecimalString(
    taxAmountStr,
    'taxAmountJmd',
    true,
  );

  const totalEstimatedOrderDec = seafoodEstimatedSubtotalDec
    .plus(nonSeafoodSubtotalDec)
    .plus(deliveryChargeDec)
    .plus(taxAmountDec);

  const totalCeilingOrderDec = seafoodCeilingSubtotalDec
    .plus(nonSeafoodSubtotalDec)
    .plus(deliveryChargeDec)
    .plus(taxAmountDec);

  const issuedAtDate = params.issuedAt ?? new Date();
  const expiresAtDate = new Date(issuedAtDate.getTime() + ttlMs);

  const payload: SeafoodCheckoutQuotePayload = {
    schemaVersion: CHECKOUT_QUOTE_SCHEMA_VERSION,
    quoteId: params.quoteId ?? crypto.randomUUID(),
    authenticatedCustomerId: params.authenticatedCustomerId,
    cartId: params.cartId,
    cartRevisionHash: params.cartRevisionHash,
    items: validatedItems,
    estimatedSeafoodSubtotalJmd: seafoodEstimatedSubtotalDec.toFixed(2),
    nonSeafoodSubtotalJmd: nonSeafoodSubtotalDec.toFixed(2),
    deliveryZoneId: params.deliveryZoneId ?? null,
    deliveryChargeJmd: deliveryChargeDec.toFixed(2),
    taxAmountJmd: taxAmountDec.toFixed(2),
    completeEstimatedOrderTotalJmd: totalEstimatedOrderDec.toFixed(2),
    completeOrderAuthorizedCeilingJmd: totalCeilingOrderDec.toFixed(2),
    termsVersion: params.termsVersion,
    issuedAt: issuedAtDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
  };

  // SEC-03: Validate complete structural and financial payload before signing
  validateQuotePayloadStructure(payload);

  const signature = computeQuoteSignature(payload, secret);

  return {
    payload,
    signature,
  };
}

/**
 * Issues a signed quote and returns the base64url token string directly.
 */
export function issueQuoteToken(params: IssueQuoteParams, secret: string): string {
  const signed = issueQuote(params, secret);
  return encodeQuoteToken(signed);
}

/**
 * Verifies a signed quote token or object.
 * Enforces schema version, signature validity, expiration, customer ownership, and cart revision stability.
 */
export function verifyQuote(
  tokenOrSigned: string | SignedSeafoodCheckoutQuote,
  options: VerifyQuoteOptions,
): SeafoodCheckoutQuotePayload {
  if (!options || !options.secret || typeof options.secret !== 'string' || options.secret.trim() === '') {
    throw new CheckoutQuoteError('A non-empty secret is required for quote verification', 'MISSING_SECRET');
  }

  let signedQuote: SignedSeafoodCheckoutQuote;
  if (typeof tokenOrSigned === 'string') {
    signedQuote = decodeQuoteToken(tokenOrSigned);
  } else if (
    tokenOrSigned &&
    typeof tokenOrSigned === 'object' &&
    tokenOrSigned.payload &&
    typeof tokenOrSigned.signature === 'string'
  ) {
    // SEC-05: Input bounded verification for object form
    const serialized = JSON.stringify(tokenOrSigned);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTE_TOKEN_BYTES) {
      throw new OversizedQuoteTokenError(Buffer.byteLength(serialized, 'utf8'), MAX_QUOTE_TOKEN_BYTES);
    }

    signedQuote = {
      payload: tokenOrSigned.payload,
      signature: tokenOrSigned.signature,
    };
  } else {
    throw new MalformedQuoteTokenError('Invalid input: expected token string or SignedSeafoodCheckoutQuote object');
  }

  const { payload, signature } = signedQuote;

  // Schema version check
  if (payload.schemaVersion !== CHECKOUT_QUOTE_SCHEMA_VERSION) {
    throw new UnsupportedQuoteSchemaVersionError(payload.schemaVersion);
  }

  // Timing-safe HMAC signature verification
  const isValidSignature = verifyQuoteSignature(payload, signature, options.secret);
  if (!isValidSignature) {
    throw new InvalidQuoteSignatureError();
  }

  // Once cryptographic integrity is verified, execute deep runtime payload validation
  validateQuotePayloadStructure(payload);

  // Timing and expiration checks
  const now = options.now ?? new Date();
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);

  // Future-issued quote check (P2-02 clock skew enforcement)
  const skewMs = issuedAt.getTime() - now.getTime();
  if (skewMs > MAX_ALLOWABLE_CLOCK_SKEW_MS) {
    throw new FutureQuoteError(payload.issuedAt, now.toISOString(), skewMs);
  }

  // Expiration check
  if (isNaN(expiresAt.getTime()) || now.getTime() > expiresAt.getTime()) {
    throw new QuoteExpiredError(payload.expiresAt, now.toISOString());
  }

  // Customer binding validation
  if (options.expectedCustomerId && payload.authenticatedCustomerId !== options.expectedCustomerId) {
    throw new QuoteOwnershipMismatchError(options.expectedCustomerId, payload.authenticatedCustomerId);
  }

  // Cart ID binding validation
  if (options.expectedCartId && payload.cartId !== options.expectedCartId) {
    throw new CheckoutQuoteError(
      `Quote cartId "${payload.cartId}" does not match expected cartId "${options.expectedCartId}"`,
      'CART_MISMATCH',
    );
  }

  // Cart revision binding validation
  if (options.expectedCartRevisionHash && payload.cartRevisionHash !== options.expectedCartRevisionHash) {
    throw new StaleCartRevisionError(options.expectedCartRevisionHash, payload.cartRevisionHash);
  }

  return payload;
}

@Injectable()
export class CheckoutQuoteService {
  issueQuote(params: IssueQuoteParams, secret: string): SignedSeafoodCheckoutQuote {
    return issueQuote(params, secret);
  }

  issueQuoteToken(params: IssueQuoteParams, secret: string): string {
    return issueQuoteToken(params, secret);
  }

  verifyQuote(
    tokenOrSigned: string | SignedSeafoodCheckoutQuote,
    options: VerifyQuoteOptions,
  ): SeafoodCheckoutQuotePayload {
    return verifyQuote(tokenOrSigned, options);
  }

  computeCartRevisionHash(
    items: Array<{
      id: string;
      productId: string;
      quantity: number;
      mutationVersion: number;
    }>,
  ): string {
    return computeCartRevisionHash(items);
  }

  encodeQuoteToken(signedQuote: SignedSeafoodCheckoutQuote): string {
    return encodeQuoteToken(signedQuote);
  }

  decodeQuoteToken(token: string): SignedSeafoodCheckoutQuote {
    return decodeQuoteToken(token);
  }

  canonicalJsonStringify(val: unknown): string {
    return canonicalJsonStringify(val);
  }

  computeQuoteSignature(payload: SeafoodCheckoutQuotePayload, secret: string): string {
    return computeQuoteSignature(payload, secret);
  }

  verifyQuoteSignature(payload: SeafoodCheckoutQuotePayload, signature: string, secret: string): boolean {
    return verifyQuoteSignature(payload, signature, secret);
  }

  computeEstimatedProductSubtotal(params: {
    readonly unit: ProductUnit;
    readonly unitPrice: string | Decimal;
    readonly pieceCount: number;
    readonly weight?: number | Decimal | null;
    readonly weightUnit?: WeightUnit;
  }): Decimal {
    return computeEstimatedProductSubtotal(params);
  }

  computePreparationFee(params: {
    readonly chargeMethod: PreparationChargeMethod;
    readonly rate: string | Decimal;
    readonly fishCount?: number | null;
    readonly originalWholeWeight?: number | Decimal | null;
    readonly originalWholeWeightUnit?: WeightUnit;
  }): Decimal {
    return computePreparationFee(params);
  }

  computeQuotePayloadHash(payload: SeafoodCheckoutQuotePayload): string {
    return computeQuotePayloadHash(payload);
  }
}

/**
 * Computes the 64-character lowercase hexadecimal SHA-256 digest of a quote payload.
 * Canonicalizes keys alphabetically to ensure deterministic hashing.
 */
export function computeQuotePayloadHash(payload: SeafoodCheckoutQuotePayload): string {
  const canonical = canonicalJsonStringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
