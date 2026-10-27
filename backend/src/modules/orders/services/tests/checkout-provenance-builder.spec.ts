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
  SyntheticProvenanceForbiddenError,
} from '../../../weight-adjustment/domain/seafood-purchase-provenance.types';
import {
  BuildProvenanceSnapshotParams,
  CeilingBelowMinimumError,
  PreparationChargeMethod,
  PreparationPricingError,
} from '../../types/checkout-provenance.types';
import {
  assertNoSyntheticProvenanceBackfill,
  buildProvenanceSnapshot,
  deepFreeze,
  isSeafoodListing,
  verifyWholeRawPricingRule,
} from '../checkout-provenance-builder';

describe('CheckoutProvenanceBuilder (Pure Primitives & Preparation Pricing)', () => {
  const baseParams: BuildProvenanceSnapshotParams = {
    orderItemId: 'order-item-100',
    listing: {
      id: 'listing-snapper-today',
      vendorId: 'vendor-port-royal-fisheries',
      lotId: 'lot-snapper-001',
      productId: 'product-snapper-1',
    },
    lot: {
      id: 'lot-snapper-001',
      vendorId: 'vendor-port-royal-fisheries',
      species: 'Lutjanus campechanus',
      foodSafetyStatus: 'APPROVED',
    },
    product: {
      id: 'product-snapper-1',
      name: 'Fresh Red Snapper',
      description: 'Wild-caught Jamaican Red Snapper',
      weightLbs: 2.5,
    },
    unit: ProductUnit.PER_POUND,
    unitPrice: '1500.00',
    currency: 'JMD',
    pieceCount: 1,
    estimatedWeightLbs: 2.5,
    fishCount: 1,
    originalWholeWeightLbs: 2.5,
    originalWholeWeightUnit: WeightUnit.POUNDS,
    pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
    selectedPreparationOption: {
      id: 'prep-scaled-gutted',
      name: 'Scaled & Gutted',
      chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
      rate: '250.00',
      fee: '250.00',
      currency: 'JMD',
    },
    usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
    authorizedCeilingJmd: '4500.00',
    termsVersion: 'v2026.10',
    quoteId: 'quote-abc-123',
    payloadHash: 'hash-of-quote-payload',
    consentedAt: '2026-10-26T12:00:00.000Z',
    purchasedAt: '2026-10-26T12:01:00.000Z',
  };

  describe('buildProvenanceSnapshot', () => {
    it('should build a valid, deep-frozen SeafoodPurchaseSnapshotV1 for WHOLE_RAW pricing basis', () => {
      const snapshot = buildProvenanceSnapshot(baseParams);

      expect(snapshot.schemaVersion).toEqual(SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION);
      expect(snapshot.originalLotId).toEqual('lot-snapper-001');
      expect(snapshot.originalListingId).toEqual('listing-snapper-today');
      expect(snapshot.vendorId).toEqual('vendor-port-royal-fisheries');
      expect(snapshot.productId).toEqual('product-snapper-1');
      expect(snapshot.productName).toEqual('Fresh Red Snapper');
      expect(snapshot.species).toEqual('Lutjanus campechanus');
      expect(snapshot.pricingBasis).toEqual(SeafoodPricingBasis.WHOLE_RAW);
      expect(snapshot.currency).toEqual('JMD');
      expect(snapshot.unitPrice).toEqual('1500.00');
      expect(snapshot.pieceCount).toEqual(1);
      expect(snapshot.estimatedWeightLbs).toEqual(2.5);
      expect(snapshot.selectedPreparationOption).toEqual({
        id: 'prep-scaled-gutted',
        name: 'Scaled & Gutted',
        fee: '250.00',
        currency: 'JMD',
      });
      expect(snapshot.usablePartsPreference).toEqual(UsablePartsPreference.RETURN_USABLE_PARTS);
      expect(snapshot.ceilingConsent).toEqual({
        authorizedCeilingJmd: '4500.00',
        termsVersion: 'v2026.10',
        payloadHash: 'hash-of-quote-payload',
        consentedAt: '2026-10-26T12:00:00.000Z',
      });
      expect(snapshot.purchasedAt).toEqual('2026-10-26T12:01:00.000Z');

      // Deep immutability verification (P2-03)
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.ceilingConsent)).toBe(true);
      expect(Object.isFrozen(snapshot.selectedPreparationOption)).toBe(true);
      expect(() => {
        (snapshot.ceilingConsent as any).authorizedCeilingJmd = '1.00';
      }).toThrow();
    });

    it('should build a valid snapshot with FIXED_PER_POUND preparation pricing', () => {
      // 3.0 lbs * 50.00/lb = 150.00 prep fee
      // Product subtotal: 3.0 lbs * 1500 = 4500.00. Estimated item total: 4650.00.
      const perPoundPrepParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        estimatedWeightLbs: 3.0,
        originalWholeWeightLbs: 3.0,
        originalWholeWeightUnit: WeightUnit.POUNDS,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          fee: '150.00',
          currency: 'JMD',
        },
        authorizedCeilingJmd: '5000.00',
      };

      const snapshot = buildProvenanceSnapshot(perPoundPrepParams);
      expect(snapshot.selectedPreparationOption?.fee).toEqual('150.00');
    });

    it('should build a valid snapshot with NO_PREPARATION charge method', () => {
      const noPrepParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          id: 'prep-none',
          name: 'No Preparation',
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0.00',
          fee: '0.00',
          currency: 'JMD',
        },
        authorizedCeilingJmd: '4000.00',
      };

      const snapshot = buildProvenanceSnapshot(noPrepParams);
      expect(snapshot.selectedPreparationOption?.fee).toEqual('0.00');
    });

    it('should reject FIXED_PER_FISH when fishCount is missing or non-positive', () => {
      const missingFishCountParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        fishCount: undefined,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '250.00',
          fee: '250.00',
        },
      };

      expect(() => buildProvenanceSnapshot(missingFishCountParams)).toThrow(
        PreparationPricingError,
      );
    });

    it('should reject FIXED_PER_POUND when originalWholeWeightLbs is missing', () => {
      const missingWeightParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        originalWholeWeightLbs: undefined,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          fee: '150.00',
        },
      };

      expect(() => buildProvenanceSnapshot(missingWeightParams)).toThrow(
        PreparationPricingError,
      );
    });

    it('should reject preparation option when fee does not match computed fee', () => {
      // 1 fish * 250.00 = 250.00, but fee claimed is 500.00
      const mismatchedFeeParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        fishCount: 1,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '250.00',
          fee: '500.00',
        },
      };

      expect(() => buildProvenanceSnapshot(mismatchedFeeParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });

    it('should reject preparation option missing chargeMethod, invalid chargeMethod, or missing rate (Defect B fix)', () => {
      const missingChargeMethodParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: undefined,
          rate: '250.00',
          fee: '250.00',
        },
      };
      expect(() => buildProvenanceSnapshot(missingChargeMethodParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const invalidChargeMethodParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: 'INVALID_CHARGE_METHOD' as any,
          rate: '250.00',
          fee: '250.00',
        },
      };
      expect(() => buildProvenanceSnapshot(invalidChargeMethodParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const missingRateParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: undefined,
          fee: '250.00',
        },
      };
      expect(() => buildProvenanceSnapshot(missingRateParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const emptyRateParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          id: 'prep-scaled',
          name: 'Scaled',
          chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          rate: '   ',
          fee: '250.00',
        },
      };
      expect(() => buildProvenanceSnapshot(emptyRateParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });

    it('should build a valid snapshot for DRESSED pricing basis without preparation option', () => {
      const dressedParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        pricingBasis: SeafoodPricingBasis.DRESSED,
        selectedPreparationOption: undefined,
        usablePartsPreference: undefined,
        // 2.5 lbs * 1500 = 3750.00; ceiling 3800.00 >= 3750.00
        authorizedCeilingJmd: '3800.00',
      };

      const snapshot = buildProvenanceSnapshot(dressedParams);

      expect(snapshot.pricingBasis).toEqual(SeafoodPricingBasis.DRESSED);
      expect(snapshot.selectedPreparationOption).toBeUndefined();
      expect(snapshot.usablePartsPreference).toBeUndefined();
      expect(snapshot.ceilingConsent?.authorizedCeilingJmd).toEqual('3800.00');
    });

    it('should build a valid snapshot for FINISHED_PRODUCT pricing basis', () => {
      const finishedParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        pricingBasis: SeafoodPricingBasis.FINISHED_PRODUCT,
        selectedPreparationOption: undefined,
        authorizedCeilingJmd: '4000.00',
      };

      const snapshot = buildProvenanceSnapshot(finishedParams);
      expect(snapshot.pricingBasis).toEqual(SeafoodPricingBasis.FINISHED_PRODUCT);
    });

    it('should calculate PER_ITEM pricing strictly based on pieceCount (P1-03)', () => {
      // 3 pieces * 500 = 1500.00 item subtotal. Even with estimatedWeightLbs = 10 lbs,
      // it must not calculate 10 * 500 = 5000. Ceiling of 2000.00 must be accepted.
      const perItemParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        unit: ProductUnit.PER_ITEM,
        unitPrice: '500.00',
        pieceCount: 3,
        estimatedWeightLbs: 10.0,
        selectedPreparationOption: undefined,
        authorizedCeilingJmd: '2000.00',
      };

      const snapshot = buildProvenanceSnapshot(perItemParams);
      expect(snapshot.unit).toEqual(ProductUnit.PER_ITEM);
      expect(snapshot.pieceCount).toEqual(3);
    });

    it('should calculate PER_PACKAGE pricing strictly based on pieceCount (P1-03)', () => {
      // 2 packages * 1000 = 2000.00. Ceiling 2500.00 is accepted.
      const perPackageParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        unit: ProductUnit.PER_PACKAGE,
        unitPrice: '1000.00',
        pieceCount: 2,
        estimatedWeightLbs: 8.0,
        selectedPreparationOption: undefined,
        authorizedCeilingJmd: '2500.00',
      };

      const snapshot = buildProvenanceSnapshot(perPackageParams);
      expect(snapshot.unit).toEqual(ProductUnit.PER_PACKAGE);
      expect(snapshot.pieceCount).toEqual(2);
    });

    it('should calculate PER_KILOGRAM pricing by converting pounds to kilograms via 2.20462 (P1-03)', () => {
      // 4.40924 lbs / 2.20462 = 2.0 kg; 2.0 kg * 2000 JMD/kg = 4000.00 JMD.
      // If silently treated as pounds, 4.40924 * 2000 would be ~8818.48 JMD.
      // With ceiling 4500.00, it must succeed because 4500 >= 4000.
      const perKgParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        unit: ProductUnit.PER_KILOGRAM,
        unitPrice: '2000.00',
        pieceCount: 1,
        estimatedWeightLbs: 4.40924,
        selectedPreparationOption: undefined,
        authorizedCeilingJmd: '4500.00',
      };

      const snapshot = buildProvenanceSnapshot(perKgParams);
      expect(snapshot.unit).toEqual(ProductUnit.PER_KILOGRAM);

      // Verify it rejects ceiling below true kg estimate (e.g. 3900 < 4000)
      const lowCeilingKgParams: BuildProvenanceSnapshotParams = {
        ...perKgParams,
        authorizedCeilingJmd: '3900.00',
      };
      expect(() => buildProvenanceSnapshot(lowCeilingKgParams)).toThrow(CeilingBelowMinimumError);
    });

    it('should reject snapshot when listing.lotId does not match lot.id (lot/listing mismatch)', () => {
      const mismatchedParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        listing: {
          ...baseParams.listing,
          lotId: 'different-lot-id',
        },
      };

      expect(() => buildProvenanceSnapshot(mismatchedParams)).toThrow(
        ProvenanceConsistencyViolationError,
      );
    });

    it('should reject snapshot when listing.vendorId does not match lot.vendorId', () => {
      const mismatchedParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        listing: {
          ...baseParams.listing,
          vendorId: 'vendor-alpha',
        },
        lot: {
          ...baseParams.lot,
          vendorId: 'vendor-beta',
        },
      };

      expect(() => buildProvenanceSnapshot(mismatchedParams)).toThrow(
        ProvenanceConsistencyViolationError,
      );
    });

    it('should reject snapshot when listing.productId does not match product.id', () => {
      const mismatchedParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        listing: {
          ...baseParams.listing,
          productId: 'prod-differs',
        },
      };

      expect(() => buildProvenanceSnapshot(mismatchedParams)).toThrow(
        ProvenanceConsistencyViolationError,
      );
    });

    it('should reject snapshot when pricingBasis is invalid', () => {
      const invalidParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        pricingBasis: 'NON_EXISTENT_BASIS' as any,
      };

      expect(() => buildProvenanceSnapshot(invalidParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });

    it('should reject snapshot when currency is not JMD', () => {
      const invalidParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        currency: 'USD',
      };

      expect(() => buildProvenanceSnapshot(invalidParams)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });

    it('should reject snapshot when monetary precision has more than 2 decimal places', () => {
      const invalidUnitPrice: BuildProvenanceSnapshotParams = {
        ...baseParams,
        unitPrice: '1500.555',
      };
      expect(() => buildProvenanceSnapshot(invalidUnitPrice)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const invalidPrepFee: BuildProvenanceSnapshotParams = {
        ...baseParams,
        selectedPreparationOption: {
          ...baseParams.selectedPreparationOption!,
          fee: '250.123',
        },
      };
      expect(() => buildProvenanceSnapshot(invalidPrepFee)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const invalidCeiling: BuildProvenanceSnapshotParams = {
        ...baseParams,
        authorizedCeilingJmd: '4500.999',
      };
      expect(() => buildProvenanceSnapshot(invalidCeiling)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });

    it('should reject snapshot when authorized ceiling is less than estimated item total', () => {
      // 2.5 lbs * 1500 = 3750 product subtotal + 250 prep fee = 4000 estimated item total
      const lowCeilingParams: BuildProvenanceSnapshotParams = {
        ...baseParams,
        authorizedCeilingJmd: '3999.99', // Below estimated item total of 4000.00
      };

      expect(() => buildProvenanceSnapshot(lowCeilingParams)).toThrow(
        CeilingBelowMinimumError,
      );
    });

    it('should reject snapshot when ceiling is zero or negative', () => {
      const zeroCeiling: BuildProvenanceSnapshotParams = {
        ...baseParams,
        authorizedCeilingJmd: '0.00',
      };
      expect(() => buildProvenanceSnapshot(zeroCeiling)).toThrow(
        InvalidPurchaseSnapshotError,
      );

      const negativeCeiling: BuildProvenanceSnapshotParams = {
        ...baseParams,
        authorizedCeilingJmd: '-100.00',
      };
      expect(() => buildProvenanceSnapshot(negativeCeiling)).toThrow(
        InvalidPurchaseSnapshotError,
      );
    });
  });

  describe('Legacy & non-seafood exclusion rules', () => {
    it('should reject synthetic provenance backfill for legacy orders', () => {
      expect(() =>
        assertNoSyntheticProvenanceBackfill({
          isLegacyOrder: true,
          attemptingSynthesis: true,
        }),
      ).toThrow(SyntheticProvenanceForbiddenError);

      // Non-legacy or non-synthesis should pass without throwing
      expect(() =>
        assertNoSyntheticProvenanceBackfill({
          isLegacyOrder: false,
          attemptingSynthesis: true,
        }),
      ).not.toThrow();

      expect(() =>
        assertNoSyntheticProvenanceBackfill({
          isLegacyOrder: true,
          attemptingSynthesis: false,
        }),
      ).not.toThrow();
    });

    it('should correctly identify seafood listings vs non-seafood listings', () => {
      expect(isSeafoodListing({ id: 'list-1', lotId: 'lot-1' })).toBe(true);
      expect(isSeafoodListing({ id: 'list-1', lotId: '' })).toBe(false);
      expect(isSeafoodListing({ id: 'list-1' })).toBe(false);
      expect(isSeafoodListing(null)).toBe(false);
      expect(isSeafoodListing('string')).toBe(false);
    });

    it('should verify whole raw pricing rule strictly', () => {
      const wholeRawSnapshot = buildProvenanceSnapshot(baseParams);
      expect(verifyWholeRawPricingRule(wholeRawSnapshot)).toBe(true);

      const dressedSnapshot = buildProvenanceSnapshot({
        ...baseParams,
        pricingBasis: SeafoodPricingBasis.DRESSED,
        selectedPreparationOption: undefined,
        authorizedCeilingJmd: '4000.00',
      });
      expect(verifyWholeRawPricingRule(dressedSnapshot)).toBe(false);
    });
  });
});
