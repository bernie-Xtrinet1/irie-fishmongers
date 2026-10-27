import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';
import { SeafoodPurchaseSnapshotV1 } from '../../weight-adjustment/domain/seafood-purchase-provenance.types';

export const CHECKOUT_QUOTE_SCHEMA_VERSION = 1;

/**
 * Maximum quote validity period: 15 minutes (900,000 ms).
 */
export const MAX_QUOTE_TTL_MS = 15 * 60 * 1000;

/**
 * Maximum allowable clock skew into the future: 60 seconds (60,000 ms).
 */
export const MAX_ALLOWABLE_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Maximum serialized quote token size: 64 KB (65,536 bytes).
 */
export const MAX_QUOTE_TOKEN_BYTES = 64 * 1024;

/**
 * Maximum allowable seafood line items per quote to prevent unbounded processing.
 */
export const MAX_QUOTE_ITEMS_COUNT = 100;

/**
 * Approved preparation fee charge methods (WP4.3B.2F.1).
 * Exactly two chargeable methods and one zero-charge method are supported.
 */
export enum PreparationChargeMethod {
  FIXED_PER_FISH = 'FIXED_PER_FISH',
  FIXED_PER_POUND = 'FIXED_PER_POUND',
  NO_PREPARATION = 'NO_PREPARATION',
}

/**
 * Disclosed preparation selection in a quoted item.
 */
export interface QuotedPreparationOption {
  readonly id: string;
  readonly name: string;
  readonly chargeMethod: PreparationChargeMethod;
  readonly rate: string; // Vendor-configured preparation rate per fish or per pound (e.g. "150.00" or "75.00")
  readonly fee: string; // Calculated preparation fee
  readonly currency: 'JMD';
}

/**
 * Individual quoted seafood item inside the quote payload.
 */
export interface QuotedSeafoodItem {
  readonly cartItemId: string;
  readonly productId: string;
  readonly mutationVersion: number;
  readonly listingId: string;
  readonly lotId: string;
  readonly vendorId: string;
  readonly species: string;
  readonly productTitle: string;
  readonly productDescription?: string;

  // Pricing & units
  readonly pricingBasis: SeafoodPricingBasis;
  readonly unit: ProductUnit;
  readonly unitPrice: string; // Normalized decimal string (e.g. "1500.00")
  readonly currency: 'JMD';

  // Physical measures & counts
  readonly pieceCount: number;
  readonly estimatedBillableWeight: number;
  readonly weightUnit: WeightUnit;

  // Explicit fish count and original whole-fish weight (WP4.3B.2F.1)
  readonly fishCount?: number;
  readonly originalWholeWeightLbs?: number;
  readonly originalWholeWeightUnit?: WeightUnit;

  // Preparation & usable parts
  readonly selectedPreparationOption?: QuotedPreparationOption;
  readonly usablePartsPreference: UsablePartsPreference;

  // Item financials
  readonly estimatedProductSubtotal: string;
  readonly estimatedPreparationFee: string;
  readonly estimatedItemTotal: string;
  readonly minimumAuthorizedCeilingJmd: string;
  readonly customerAuthorizedCeilingJmd: string;
}

/**
 * Full integrity-protected payload for a server-issued checkout quote.
 */
export interface SeafoodCheckoutQuotePayload {
  readonly schemaVersion: typeof CHECKOUT_QUOTE_SCHEMA_VERSION;
  readonly quoteId: string;
  readonly authenticatedCustomerId: string;
  readonly cartId: string;
  readonly cartRevisionHash: string;
  readonly items: readonly QuotedSeafoodItem[];

  // Order-level summary
  readonly estimatedSeafoodSubtotalJmd: string;
  readonly nonSeafoodSubtotalJmd: string;
  readonly deliveryZoneId: string | null;
  readonly deliveryChargeJmd: string;
  readonly taxAmountJmd: string;
  readonly completeEstimatedOrderTotalJmd: string;
  readonly completeOrderAuthorizedCeilingJmd: string;

  // Terms and validity
  readonly termsVersion: string;
  readonly issuedAt: string; // ISO 8601
  readonly expiresAt: string; // ISO 8601
}

/**
 * Signed quote structure containing payload and HMAC-SHA256 signature.
 */
export interface SignedSeafoodCheckoutQuote {
  readonly payload: SeafoodCheckoutQuotePayload;
  readonly signature: string;
}

/**
 * Input for issuing a signed checkout quote.
 */
export interface IssueQuoteParams {
  readonly quoteId?: string;
  readonly authenticatedCustomerId: string;
  readonly cartId: string;
  readonly cartRevisionHash: string;
  readonly items: readonly QuotedSeafoodItem[];
  readonly nonSeafoodSubtotalJmd?: string;
  readonly deliveryZoneId?: string | null;
  readonly deliveryChargeJmd?: string;
  readonly taxAmountJmd?: string;
  readonly termsVersion: string;
  readonly ttlMs?: number; // Defaults to 15 minutes (900,000 ms), max 15 minutes
  readonly issuedAt?: Date;
}

/**
 * Options for verifying a signed checkout quote.
 */
export interface VerifyQuoteOptions {
  readonly secret: string;
  readonly expectedCustomerId?: string;
  readonly expectedCartId?: string;
  readonly expectedCartRevisionHash?: string;
  readonly now?: Date;
}

/**
 * Parameters for building a purchase provenance snapshot.
 */
export interface BuildProvenanceSnapshotParams {
  readonly orderItemId: string;
  readonly listing: {
    readonly id: string;
    readonly vendorId: string;
    readonly lotId: string;
    readonly productId: string;
  };
  readonly lot: {
    readonly id: string;
    readonly vendorId: string;
    readonly species: string;
    readonly foodSafetyStatus: string;
  };
  readonly product: {
    readonly id: string;
    readonly name: string;
    readonly description?: string | null;
    readonly weightLbs?: unknown;
  };
  readonly unit: ProductUnit;
  readonly unitPrice: string;
  readonly currency?: string;
  readonly pieceCount: number;
  readonly estimatedWeightLbs?: number;
  readonly fishCount?: number;
  readonly originalWholeWeightLbs?: number;
  readonly originalWholeWeightUnit?: WeightUnit;
  readonly pricingBasis: SeafoodPricingBasis;
  readonly selectedPreparationOption?: {
    readonly id: string;
    readonly name: string;
    readonly chargeMethod?: PreparationChargeMethod;
    readonly rate?: string;
    readonly fee: string;
    readonly currency?: string;
  };
  readonly usablePartsPreference?: UsablePartsPreference;
  readonly authorizedCeilingJmd: string;
  readonly termsVersion: string;
  readonly quoteId?: string;
  readonly payloadHash?: string;
  readonly consentedAt?: string;
  readonly purchasedAt: string;
}

/**
 * Base error class for checkout quote errors.
 */
export class CheckoutQuoteError extends Error {
  constructor(message: string, public readonly code: string) {
    super(`[CHECKOUT_QUOTE_ERROR] ${code}: ${message}`);
    this.name = 'CheckoutQuoteError';
  }
}

export class InvalidQuoteSignatureError extends CheckoutQuoteError {
  constructor(message = 'HMAC signature verification failed. Quote has been tampered with or secret is invalid.') {
    super(message, 'INVALID_SIGNATURE');
    this.name = 'InvalidQuoteSignatureError';
  }
}

export class QuoteExpiredError extends CheckoutQuoteError {
  constructor(expiresAt: string, checkedAt: string) {
    super(`Checkout quote expired at "${expiresAt}" (checked at "${checkedAt}").`, 'QUOTE_EXPIRED');
    this.name = 'QuoteExpiredError';
  }
}

export class FutureQuoteError extends CheckoutQuoteError {
  constructor(issuedAt: string, checkedAt: string, skewMs: number) {
    super(
      `Quote issuance time "${issuedAt}" is in the future relative to current time "${checkedAt}" (skew: ${skewMs}ms exceeds allowable limit).`,
      'FUTURE_QUOTE',
    );
    this.name = 'FutureQuoteError';
  }
}

export class QuoteOwnershipMismatchError extends CheckoutQuoteError {
  constructor(expectedCustomerId: string, actualCustomerId: string) {
    super(
      `Quote customer "${actualCustomerId}" does not match authenticated customer "${expectedCustomerId}".`,
      'OWNERSHIP_MISMATCH',
    );
    this.name = 'QuoteOwnershipMismatchError';
  }
}

export class StaleCartRevisionError extends CheckoutQuoteError {
  constructor(expectedHash: string, actualHash: string) {
    super(
      `Cart revision has changed since quote was issued. Expected "${expectedHash}", but cart is now "${actualHash}".`,
      'STALE_CART_REVISION',
    );
    this.name = 'StaleCartRevisionError';
  }
}

export class CartRevisionIntegrityError extends CheckoutQuoteError {
  constructor(detail: string) {
    super(`Cart revision integrity violation: ${detail}`, 'CART_REVISION_INTEGRITY_ERROR');
    this.name = 'CartRevisionIntegrityError';
  }
}

export class MalformedQuoteTokenError extends CheckoutQuoteError {
  constructor(detail: string) {
    super(`Malformed quote token: ${detail}`, 'MALFORMED_TOKEN');
    this.name = 'MalformedQuoteTokenError';
  }
}

export class OversizedQuoteTokenError extends CheckoutQuoteError {
  constructor(sizeOrMessage: number | string, max?: number) {
    if (typeof sizeOrMessage === 'string') {
      super(sizeOrMessage, 'OVERSIZED_TOKEN');
    } else {
      super(`Quote token size (${sizeOrMessage} bytes) exceeds maximum limit (${max ?? 0} bytes).`, 'OVERSIZED_TOKEN');
    }
    this.name = 'OversizedQuoteTokenError';
  }
}

export class UnsupportedQuoteSchemaVersionError extends CheckoutQuoteError {
  constructor(version: unknown) {
    super(
      `Unsupported quote schema version "${String(version)}". Expected version ${CHECKOUT_QUOTE_SCHEMA_VERSION}.`,
      'UNSUPPORTED_SCHEMA_VERSION',
    );
    this.name = 'UnsupportedQuoteSchemaVersionError';
  }
}

export class CeilingBelowMinimumError extends CheckoutQuoteError {
  constructor(itemId: string, authorizedCeiling: string, minimumCeiling: string) {
    super(
      `Authorized ceiling JMD ${authorizedCeiling} for item "${itemId}" cannot be less than estimated item total JMD ${minimumCeiling}.`,
      'CEILING_BELOW_MINIMUM',
    );
    this.name = 'CeilingBelowMinimumError';
  }
}

export class FinancialIntegrityError extends CheckoutQuoteError {
  constructor(detail: string) {
    super(`Financial integrity violation: ${detail}`, 'FINANCIAL_INTEGRITY_ERROR');
    this.name = 'FinancialIntegrityError';
  }
}

export class PreparationPricingError extends CheckoutQuoteError {
  constructor(detail: string) {
    super(`Preparation pricing violation: ${detail}`, 'PREPARATION_PRICING_ERROR');
    this.name = 'PreparationPricingError';
  }
}
