import {
  CHECKOUT_QUOTE_SCHEMA_VERSION,
  CartRevisionIntegrityError,
  CeilingBelowMinimumError,
  CheckoutQuoteError,
  FinancialIntegrityError,
  FutureQuoteError,
  InvalidQuoteSignatureError,
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
} from '../../types/checkout-provenance.types';
import {
  CheckoutQuoteService,
  canonicalJsonStringify,
  computeCartRevisionHash,
  computeEstimatedProductSubtotal,
  computePreparationFee,
  computeQuoteSignature,
  decodeQuoteToken,
  encodeQuoteToken,
  issueQuote,
  issueQuoteToken,
  validateQuotePayloadStructure,
  verifyQuote,
  verifyQuoteSignature,
} from '../checkout-quote.service';
import {
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightUnit,
} from '@prisma/client';

describe('CheckoutQuoteService (Pure Primitives & Security Corrections)', () => {
  const TEST_SECRET = 'test-signing-secret-super-secure-key-12345';

  const sampleItem: QuotedSeafoodItem = {
    cartItemId: 'cart-item-1',
    productId: 'product-snapper-1',
    mutationVersion: 1,
    listingId: 'listing-snapper-today',
    lotId: 'lot-snapper-001',
    vendorId: 'vendor-port-royal-fisheries',
    species: 'Lutjanus campechanus',
    productTitle: 'Fresh Red Snapper',
    productDescription: 'Wild-caught Jamaican Red Snapper',
    pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
    unit: ProductUnit.PER_POUND,
    unitPrice: '1500.00',
    currency: 'JMD',
    pieceCount: 1,
    estimatedBillableWeight: 2.5,
    weightUnit: WeightUnit.POUNDS,
    fishCount: 1,
    originalWholeWeightLbs: 2.5,
    originalWholeWeightUnit: WeightUnit.POUNDS,
    selectedPreparationOption: {
      id: 'prep-scaled-gutted',
      name: 'Scaled & Gutted',
      chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
      rate: '250.00',
      fee: '250.00',
      currency: 'JMD',
    },
    usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
    estimatedProductSubtotal: '3750.00', // 2.5 lbs * 1500.00
    estimatedPreparationFee: '250.00',
    estimatedItemTotal: '4000.00', // 3750.00 + 250.00
    minimumAuthorizedCeilingJmd: '4000.00',
    customerAuthorizedCeilingJmd: '4500.00',
  };

  const sampleIssueParams = {
    authenticatedCustomerId: 'cust-123',
    cartId: 'cart-456',
    cartRevisionHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    items: [sampleItem],
    nonSeafoodSubtotalJmd: '500.00',
    deliveryZoneId: 'zone-kingston-east',
    deliveryChargeJmd: '600.00',
    taxAmountJmd: '0.00',
    termsVersion: 'v2026.10',
    ttlMs: 15 * 60 * 1000,
  };

  describe('canonicalJsonStringify', () => {
    it('should sort keys deterministically regardless of insertion order', () => {
      const objA = { z: 1, a: 2, m: { y: 10, b: 20 } };
      const objB = { a: 2, m: { b: 20, y: 10 }, z: 1 };

      const strA = canonicalJsonStringify(objA);
      const strB = canonicalJsonStringify(objB);

      expect(strA).toEqual(strB);
      expect(strA).toEqual('{"a":2,"m":{"b":20,"y":10},"z":1}');
    });

    it('should omit undefined object properties matching JSON.stringify semantics', () => {
      const obj = { a: 1, b: undefined, c: 3 };
      expect(canonicalJsonStringify(obj)).toEqual('{"a":1,"c":3}');
    });

    it('should handle primitives and arrays correctly', () => {
      expect(canonicalJsonStringify(42)).toEqual('42');
      expect(canonicalJsonStringify('test')).toEqual('"test"');
      expect(canonicalJsonStringify([3, 1, 2])).toEqual('[3,1,2]');
      expect(canonicalJsonStringify(null)).toEqual('null');
    });
  });

  describe('computeEstimatedProductSubtotal (P1-03)', () => {
    it('should calculate PER_ITEM subtotal based strictly on pieceCount', () => {
      const subtotal = computeEstimatedProductSubtotal({
        unit: ProductUnit.PER_ITEM,
        unitPrice: '500.00',
        pieceCount: 3,
        weight: 12.5, // should be ignored for per-item
      });
      expect(subtotal.toString()).toEqual('1500');
    });

    it('should calculate PER_PACKAGE subtotal based strictly on pieceCount', () => {
      const subtotal = computeEstimatedProductSubtotal({
        unit: ProductUnit.PER_PACKAGE,
        unitPrice: '1200.00',
        pieceCount: 2,
        weight: 8.0, // should be ignored for per-package
      });
      expect(subtotal.toString()).toEqual('2400');
    });

    it('should calculate PER_POUND subtotal from billable weight in pounds', () => {
      const subtotal = computeEstimatedProductSubtotal({
        unit: ProductUnit.PER_POUND,
        unitPrice: '1500.00',
        pieceCount: 1,
        weight: 2.5,
        weightUnit: WeightUnit.POUNDS,
      });
      expect(subtotal.toString()).toEqual('3750');
    });

    it('should calculate PER_KILOGRAM subtotal converting pounds to kilograms via 2.20462', () => {
      // 4.40924 lbs / 2.20462 = 2.0 kg; 2.0 * 2000.00 = 4000.00
      const subtotal = computeEstimatedProductSubtotal({
        unit: ProductUnit.PER_KILOGRAM,
        unitPrice: '2000.00',
        pieceCount: 1,
        weight: 4.40924,
        weightUnit: WeightUnit.POUNDS,
      });
      expect(subtotal.toString()).toEqual('4000');
    });

    it('should reject missing, zero, negative or non-finite weight for PER_POUND pricing (Defect A fix)', () => {
      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: undefined,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: null,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: 0,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: -2.5,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: NaN,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_POUND,
          unitPrice: '1500.00',
          pieceCount: 1,
          weight: 'malformed-weight' as any,
        }),
      ).toThrow(FinancialIntegrityError);
    });

    it('should reject missing, zero, negative or non-finite weight for PER_KILOGRAM pricing (Defect A fix)', () => {
      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_KILOGRAM,
          unitPrice: '2000.00',
          pieceCount: 1,
          weight: undefined,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_KILOGRAM,
          unitPrice: '2000.00',
          pieceCount: 1,
          weight: 0,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_KILOGRAM,
          unitPrice: '2000.00',
          pieceCount: 1,
          weight: -1.0,
        }),
      ).toThrow(FinancialIntegrityError);

      expect(() =>
        computeEstimatedProductSubtotal({
          unit: ProductUnit.PER_KILOGRAM,
          unitPrice: '2000.00',
          pieceCount: 1,
          weight: NaN,
        }),
      ).toThrow(FinancialIntegrityError);
    });
  });

  describe('computePreparationFee (WP4.3B.2F.1)', () => {
    it('should calculate fixed fee per fish with valid fish count (FIXED_PER_FISH)', () => {
      const fee = computePreparationFee({
        chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
        rate: '150.00',
        fishCount: 3,
      });
      expect(fee.toFixed(2)).toEqual('450.00');
    });

    it('should calculate fixed fee per pound with valid original whole weight in pounds (FIXED_PER_POUND)', () => {
      const fee = computePreparationFee({
        chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
        rate: '75.00',
        originalWholeWeight: 4.5,
        originalWholeWeightUnit: WeightUnit.POUNDS,
      });
      // 4.5 * 75.00 = 337.50
      expect(fee.toFixed(2)).toEqual('337.50');
    });

    it('should calculate fixed fee per pound converting kilograms to pounds via 2.20462 (FIXED_PER_POUND)', () => {
      // 2 kg * 2.20462 = 4.40924 lbs; 4.40924 * 100.00 = 440.924 -> rounded to 440.92
      const fee = computePreparationFee({
        chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
        rate: '100.00',
        originalWholeWeight: 2.0,
        originalWholeWeightUnit: WeightUnit.KILOGRAMS,
      });
      expect(fee.toFixed(2)).toEqual('440.92');
    });

    it('should calculate zero fee for NO_PREPARATION selection with 0.00 rate', () => {
      const fee = computePreparationFee({
        chargeMethod: PreparationChargeMethod.NO_PREPARATION,
        rate: '0.00',
      });
      expect(fee.toFixed(2)).toEqual('0.00');
    });

    it('should reject NO_PREPARATION when rate is not zero', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '100.00',
        }),
      ).toThrow(PreparationPricingError);
    });

    it('should reject FIXED_PER_FISH when fishCount is missing or undefined', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '150.00',
          fishCount: undefined,
        }),
      ).toThrow(PreparationPricingError);
    });

    it('should reject FIXED_PER_FISH when fishCount is zero, negative, or fractional', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '150.00',
          fishCount: 0,
        }),
      ).toThrow(PreparationPricingError);

      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '150.00',
          fishCount: -2,
        }),
      ).toThrow(PreparationPricingError);

      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '150.00',
          fishCount: 2.5,
        }),
      ).toThrow(PreparationPricingError);
    });

    it('should reject FIXED_PER_POUND when originalWholeWeight is missing or undefined', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          originalWholeWeight: undefined,
        }),
      ).toThrow(PreparationPricingError);
    });

    it('should reject FIXED_PER_POUND when originalWholeWeight is zero, negative, or NaN', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          originalWholeWeight: 0,
        }),
      ).toThrow(PreparationPricingError);

      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          originalWholeWeight: -3.5,
        }),
      ).toThrow(PreparationPricingError);

      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          originalWholeWeight: NaN,
        }),
      ).toThrow(PreparationPricingError);
    });

    it('should reject invalid or negative preparation rate', () => {
      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '-50.00',
          fishCount: 2,
        }),
      ).toThrow();

      expect(() =>
        computePreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: 'invalid-rate',
          fishCount: 2,
        }),
      ).toThrow();
    });
  });

  describe('computeCartRevisionHash (SEC-01, SEC-02)', () => {
    it('should produce identical hashes for identically content-ordered cart items', () => {
      const itemsA = [
        { id: 'item-2', productId: 'prod-2', quantity: 1, mutationVersion: 1 },
        { id: 'item-1', productId: 'prod-1', quantity: 3, mutationVersion: 2 },
      ];
      const itemsB = [
        { id: 'item-1', productId: 'prod-1', quantity: 3, mutationVersion: 2 },
        { id: 'item-2', productId: 'prod-2', quantity: 1, mutationVersion: 1 },
      ];

      const hashA = computeCartRevisionHash(itemsA);
      const hashB = computeCartRevisionHash(itemsB);

      expect(hashA).toEqual(hashB);
      expect(hashA).toHaveLength(64);
    });

    it('should produce different hashes when quantity or mutation version changes', () => {
      const base = [{ id: 'item-1', productId: 'prod-1', quantity: 1, mutationVersion: 1 }];
      const qtyChanged = [{ id: 'item-1', productId: 'prod-1', quantity: 2, mutationVersion: 1 }];
      const verChanged = [{ id: 'item-1', productId: 'prod-1', quantity: 1, mutationVersion: 2 }];

      const baseHash = computeCartRevisionHash(base);
      expect(computeCartRevisionHash(qtyChanged)).not.toEqual(baseHash);
      expect(computeCartRevisionHash(verChanged)).not.toEqual(baseHash);
    });

    it('should reject duplicate cart item IDs', () => {
      const duplicateItems = [
        { id: 'item-dup', productId: 'prod-1', quantity: 1, mutationVersion: 1 },
        { id: 'item-dup', productId: 'prod-2', quantity: 2, mutationVersion: 1 },
      ];

      expect(() => computeCartRevisionHash(duplicateItems)).toThrow(CartRevisionIntegrityError);
    });

    it('should reject cart items with non-canonical leading or trailing whitespace in id (SEC-02)', () => {
      const leadingSpace = [{ id: ' item-1', productId: 'prod-1', quantity: 1, mutationVersion: 1 }];
      const trailingSpace = [{ id: 'item-1 ', productId: 'prod-1', quantity: 1, mutationVersion: 1 }];

      expect(() => computeCartRevisionHash(leadingSpace)).toThrow(CartRevisionIntegrityError);
      expect(() => computeCartRevisionHash(trailingSpace)).toThrow(CartRevisionIntegrityError);
    });

    it('should reject non-positive or non-integer quantities', () => {
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 0, mutationVersion: 1 }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: -2, mutationVersion: 1 }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1.5, mutationVersion: 1 }]),
      ).toThrow(CartRevisionIntegrityError);
    });

    it('should reject non-positive, non-integer, or missing mutation versions (SEC-01)', () => {
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1, mutationVersion: 0 }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1, mutationVersion: -1 }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1, mutationVersion: 1.5 }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1, mutationVersion: undefined as any }]),
      ).toThrow(CartRevisionIntegrityError);
      expect(() =>
        computeCartRevisionHash([{ id: 'item-1', productId: 'p1', quantity: 1, mutationVersion: null as any }]),
      ).toThrow(CartRevisionIntegrityError);
    });
  });

  describe('issueQuote and verifyQuote', () => {
    it('should issue and verify a valid quote with matching HMAC signature and claims', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);

      expect(signed.payload.schemaVersion).toEqual(CHECKOUT_QUOTE_SCHEMA_VERSION);
      expect(signed.payload.authenticatedCustomerId).toEqual('cust-123');
      expect(signed.payload.cartId).toEqual('cart-456');
      expect(signed.payload.estimatedSeafoodSubtotalJmd).toEqual('4000.00');
      expect(signed.payload.nonSeafoodSubtotalJmd).toEqual('500.00');
      expect(signed.payload.deliveryChargeJmd).toEqual('600.00');
      expect(signed.payload.taxAmountJmd).toEqual('0.00');
      expect(signed.payload.completeEstimatedOrderTotalJmd).toEqual('5100.00'); // 4000 + 500 + 600 + 0
      expect(signed.payload.completeOrderAuthorizedCeilingJmd).toEqual('5600.00'); // 4500 + 500 + 600 + 0
      expect(signed.signature).toHaveLength(64);

      const verified = verifyQuote(signed, {
        secret: TEST_SECRET,
        expectedCustomerId: 'cust-123',
        expectedCartId: 'cart-456',
        expectedCartRevisionHash: sampleIssueParams.cartRevisionHash,
      });

      expect(verified).toEqual(signed.payload);
    });

    it('should validate complete structural and financial payload before signing in issueQuote (SEC-03)', () => {
      // Invalid item where subtotal is wrong: issueQuote must reject before generating signature
      const invalidItem: QuotedSeafoodItem = {
        ...sampleItem,
        estimatedProductSubtotal: '9999.00', // incorrect subtotal
      };

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: [invalidItem] }, TEST_SECRET),
      ).toThrow(FinancialIntegrityError);
    });

    it('should independently recalculate and verify preparation fee against approved formulas (SEC-04)', () => {
      // Item with claimed fee 300.00 but calculated fee 250.00 (1 fish * 250.00)
      const wrongFeeItem: QuotedSeafoodItem = {
        ...sampleItem,
        selectedPreparationOption: {
          ...sampleItem.selectedPreparationOption!,
          fee: '300.00',
        },
        estimatedPreparationFee: '300.00',
        estimatedItemTotal: '4050.00',
        minimumAuthorizedCeilingJmd: '4050.00',
        customerAuthorizedCeilingJmd: '4500.00',
      };

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: [wrongFeeItem] }, TEST_SECRET),
      ).toThrow(FinancialIntegrityError);
    });

    it('should reject quote with incorrect item-total arithmetic', () => {
      // Inconsistent item: productSubtotal 3750 + fee 250 = 4000 != reported 4500
      const inconsistentItem: QuotedSeafoodItem = {
        ...sampleItem,
        estimatedProductSubtotal: '3750.00',
        estimatedPreparationFee: '250.00',
        estimatedItemTotal: '4500.00',
        customerAuthorizedCeilingJmd: '5000.00',
      };

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: [inconsistentItem] }, TEST_SECRET),
      ).toThrow(FinancialIntegrityError);
    });

    it('should encode and decode token roundtrip correctly', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);
      const token = encodeQuoteToken(signed);

      const decoded = decodeQuoteToken(token);
      expect(decoded.payload.quoteId).toEqual(signed.payload.quoteId);

      const verified = verifyQuote(token, { secret: TEST_SECRET });
      expect(verified.quoteId).toEqual(signed.payload.quoteId);
    });

    it('should reject oversized quote tokens exceeding 64KB (SEC-05)', () => {
      const hugePadding = 'a'.repeat(MAX_QUOTE_TOKEN_BYTES + 100);
      expect(() => decodeQuoteToken(hugePadding)).toThrow(OversizedQuoteTokenError);
    });

    it('should reject quote input with more than 100 items (SEC-05)', () => {
      const manyItems: QuotedSeafoodItem[] = [];
      for (let i = 0; i < MAX_QUOTE_ITEMS_COUNT + 1; i++) {
        manyItems.push({
          ...sampleItem,
          cartItemId: `cart-item-${i}`,
        });
      }

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: manyItems }, TEST_SECRET),
      ).toThrow(OversizedQuoteTokenError);
    });

    it('should reject quote with signature tampering (corrupted hex)', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);
      const tamperedSignature =
        signed.signature.slice(0, 10) +
        (signed.signature[10] === 'a' ? 'b' : 'a') +
        signed.signature.slice(11);

      const tampered = { ...signed, signature: tamperedSignature };

      expect(() =>
        verifyQuote(tampered, { secret: TEST_SECRET }),
      ).toThrow(InvalidQuoteSignatureError);
    });

    it('should reject quote when customer ID does not match expected authenticated customer', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);

      expect(() =>
        verifyQuote(signed, {
          secret: TEST_SECRET,
          expectedCustomerId: 'attacker-cust-999',
        }),
      ).toThrow(QuoteOwnershipMismatchError);
    });

    it('should reject quote when expired', () => {
      const issuedAt = new Date('2026-10-26T12:00:00.000Z');
      const signed = issueQuote(
        {
          ...sampleIssueParams,
          issuedAt,
          ttlMs: 5 * 60 * 1000, // 5 minutes
        },
        TEST_SECRET,
      );

      // Verify at 6 minutes later
      const verificationTime = new Date('2026-10-26T12:06:00.000Z');
      expect(() =>
        verifyQuote(signed, {
          secret: TEST_SECRET,
          now: verificationTime,
        }),
      ).toThrow(QuoteExpiredError);
    });

    it('should reject quote issued in the future beyond allowable clock skew (P2-02)', () => {
      const issuedAt = new Date('2026-10-26T12:05:00.000Z'); // 5 minutes in future
      const signed = issueQuote(
        {
          ...sampleIssueParams,
          issuedAt,
          ttlMs: 15 * 60 * 1000,
        },
        TEST_SECRET,
      );

      const verificationTime = new Date('2026-10-26T12:00:00.000Z'); // 5 minutes prior
      expect(() =>
        verifyQuote(signed, {
          secret: TEST_SECRET,
          now: verificationTime,
        }),
      ).toThrow(FutureQuoteError);
    });

    it('should permit quote issued in the future within 60s allowable clock skew (P2-02)', () => {
      const issuedAt = new Date('2026-10-26T12:00:30.000Z'); // 30s in future
      const signed = issueQuote(
        {
          ...sampleIssueParams,
          issuedAt,
          ttlMs: 15 * 60 * 1000,
        },
        TEST_SECRET,
      );

      const verificationTime = new Date('2026-10-26T12:00:00.000Z');
      const verified = verifyQuote(signed, {
        secret: TEST_SECRET,
        now: verificationTime,
      });
      expect(verified.quoteId).toEqual(signed.payload.quoteId);
    });

    it('should reject quote issuance with TTL exceeding 15 minutes (P2-02)', () => {
      expect(() =>
        issueQuote(
          {
            ...sampleIssueParams,
            ttlMs: 16 * 60 * 1000, // 16 minutes > 15 minutes max
          },
          TEST_SECRET,
        ),
      ).toThrow(CheckoutQuoteError);
    });

    it('should reject malformed token string', () => {
      expect(() => verifyQuote('not-valid-base64-!!@@##', { secret: TEST_SECRET })).toThrow(
        MalformedQuoteTokenError,
      );
      expect(() => verifyQuote('', { secret: TEST_SECRET })).toThrow(
        MalformedQuoteTokenError,
      );
      expect(() => verifyQuote('{}', { secret: TEST_SECRET })).toThrow(
        MalformedQuoteTokenError,
      );
    });

    it('should reject quote with unsupported schema version', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);
      const unsupported = {
        ...signed,
        payload: {
          ...signed.payload,
          schemaVersion: 99 as any,
        },
      };

      expect(() =>
        verifyQuote(unsupported, { secret: TEST_SECRET }),
      ).toThrow(UnsupportedQuoteSchemaVersionError);
    });

    it('should reject quote when item ceiling in payload is altered without resigning', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);
      const firstItem = signed.payload.items[0];
      if (!firstItem) {
        throw new Error('Expected at least one item');
      }
      const alteredItem: QuotedSeafoodItem = {
        ...firstItem,
        customerAuthorizedCeilingJmd: '5000.00', // altered ceiling
      };
      const tamperedPayload: SeafoodCheckoutQuotePayload = {
        ...signed.payload,
        items: [alteredItem],
      };

      expect(() =>
        verifyQuote({ payload: tamperedPayload, signature: signed.signature }, { secret: TEST_SECRET }),
      ).toThrow(InvalidQuoteSignatureError);
    });

    it('should reject quote when product subtotal does not match unit-based calculation (P1-02)', () => {
      // 2.5 lbs * 1500 = 3750, but reported as 3000
      const mismatchedSubtotalItem: QuotedSeafoodItem = {
        ...sampleItem,
        estimatedProductSubtotal: '3000.00',
        estimatedItemTotal: '3250.00',
        customerAuthorizedCeilingJmd: '4000.00',
      };

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: [mismatchedSubtotalItem] }, TEST_SECRET),
      ).toThrow(FinancialIntegrityError);
    });

    it('should reject quote when cart revision hash does not match current cart state', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);

      expect(() =>
        verifyQuote(signed, {
          secret: TEST_SECRET,
          expectedCartRevisionHash: 'different-stale-cart-hash',
        }),
      ).toThrow(StaleCartRevisionError);
    });

    it('should reject quote when cartId does not match expectedCartId', () => {
      const signed = issueQuote(sampleIssueParams, TEST_SECRET);

      expect(() =>
        verifyQuote(signed, {
          secret: TEST_SECRET,
          expectedCartId: 'other-cart-id',
        }),
      ).toThrow(CheckoutQuoteError);
    });

    it('should produce identical signature regardless of object property insertion order (canonical stability)', () => {
      const itemReorderedKeys: QuotedSeafoodItem = {
        customerAuthorizedCeilingJmd: '4500.00',
        minimumAuthorizedCeilingJmd: '4000.00',
        estimatedItemTotal: '4000.00',
        estimatedPreparationFee: '250.00',
        estimatedProductSubtotal: '3750.00',
        usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
        selectedPreparationOption: {
          currency: 'JMD',
          fee: '250.00',
          rate: '250.00',
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          name: 'Scaled & Gutted',
          id: 'prep-scaled-gutted',
        },
        originalWholeWeightUnit: WeightUnit.POUNDS,
        originalWholeWeightLbs: 2.5,
        fishCount: 1,
        weightUnit: WeightUnit.POUNDS,
        estimatedBillableWeight: 2.5,
        pieceCount: 1,
        currency: 'JMD',
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        productDescription: 'Wild-caught Jamaican Red Snapper',
        productTitle: 'Fresh Red Snapper',
        species: 'Lutjanus campechanus',
        vendorId: 'vendor-port-royal-fisheries',
        lotId: 'lot-snapper-001',
        listingId: 'listing-snapper-today',
        mutationVersion: 1,
        productId: 'product-snapper-1',
        cartItemId: 'cart-item-1',
      };

      const issuedA = issueQuote(
        { ...sampleIssueParams, quoteId: 'fixed-quote-id', issuedAt: new Date('2026-10-26T12:00:00.000Z') },
        TEST_SECRET,
      );
      const issuedB = issueQuote(
        {
          ...sampleIssueParams,
          quoteId: 'fixed-quote-id',
          issuedAt: new Date('2026-10-26T12:00:00.000Z'),
          items: [itemReorderedKeys],
        },
        TEST_SECRET,
      );

      expect(issuedA.signature).toEqual(issuedB.signature);
    });

    it('should reject quote issuance if customer ceiling is below estimated item total', () => {
      const invalidItem: QuotedSeafoodItem = {
        ...sampleItem,
        estimatedItemTotal: '4000.00',
        customerAuthorizedCeilingJmd: '3500.00', // Invalid: below estimated total
      };

      expect(() =>
        issueQuote({ ...sampleIssueParams, items: [invalidItem] }, TEST_SECRET),
      ).toThrow(CeilingBelowMinimumError);
    });

    it('should reject missing or empty secret for both issue and verify', () => {
      expect(() => issueQuote(sampleIssueParams, '')).toThrow(CheckoutQuoteError);
      expect(() =>
        verifyQuote('some-token', { secret: '' }),
      ).toThrow(CheckoutQuoteError);
    });
  });

  describe('CheckoutQuoteService injectable wrapper', () => {
    it('should delegate all operations identically to pure functions', () => {
      const service = new CheckoutQuoteService();
      const token = service.issueQuoteToken(sampleIssueParams, TEST_SECRET);
      const verified = service.verifyQuote(token, { secret: TEST_SECRET });

      expect(verified.authenticatedCustomerId).toEqual('cust-123');
    });
  });
});
