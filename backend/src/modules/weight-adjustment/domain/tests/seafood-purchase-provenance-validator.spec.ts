import * as fs from 'fs';
import * as path from 'path';
import { ProductUnit, SeafoodPricingBasis, UsablePartsPreference, WeightUnit } from '@prisma/client';
import {
  InvalidPurchaseSnapshotError,
  PreparationChargeMethod,
  ProvenanceConsistencyViolationError,
  ProvenanceImmutabilityViolationError,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V1,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
  SeafoodPurchaseSnapshotV1,
  SeafoodPurchaseSnapshotV2,
  SyntheticProvenanceForbiddenError,
} from '../seafood-purchase-provenance.types';
import {
  computeV2PreparationFee,
  SeafoodPurchaseProvenanceValidator,
  validateMonetaryDecimalString,
} from '../seafood-purchase-provenance-validator';

describe('Phase 16D WP4.1: Hybrid Purchase-Time Provenance & Immutability Suite', () => {
  const validSnapshot: SeafoodPurchaseSnapshotV1 = {
    schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
    originalLotId: 'lot-uuid-1',
    originalListingId: 'listing-uuid-1',
    vendorId: 'vendor-uuid-1',
    productId: 'product-uuid-1',
    productName: 'Yellowfin Tuna Whole',
    productDescription: 'Freshly caught Yellowfin Tuna',
    species: 'Thunnus albacares',
    pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
    currency: 'JMD',
    unitPrice: '1500.00',
    unit: ProductUnit.PER_POUND,
    pieceCount: 1,
    estimatedWeightLbs: 12.5,
    selectedPreparationOption: {
      id: 'prep-gutted-scaled',
      name: 'Gutted & Scaled',
      fee: '200.00',
      currency: 'JMD',
    },
    usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
    ceilingConsent: {
      authorizedCeilingJmd: '22000.00',
      termsVersion: 'v2026.1',
      payloadHash: 'hash-abc-123',
    },
    purchasedAt: '2026-10-25T12:00:00.000Z',
  };

  const validListing = {
    id: 'listing-uuid-1',
    vendorId: 'vendor-uuid-1',
    lotId: 'lot-uuid-1',
    productId: 'product-uuid-1',
  };

  const validLot = {
    id: 'lot-uuid-1',
    vendorId: 'vendor-uuid-1',
  };

  // 1. NULL-to-value provenance mutation is prohibited
  it('1. prohibits NULL-to-value provenance mutation on existing records (anti-backfill)', () => {
    const legacyItem = {
      id: 'oi-legacy-1',
      originalLotId: null,
      originalListingId: null,
      purchaseSnapshot: null,
    };

    // Attempting to backfill originalLotId on an existing row must throw
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: legacyItem.id,
        existing: legacyItem,
        update: { originalLotId: 'lot-uuid-new' },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempting to backfill originalListingId must throw
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: legacyItem.id,
        existing: legacyItem,
        update: { originalListingId: 'listing-uuid-new' },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempting to backfill purchaseSnapshot must throw
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: legacyItem.id,
        existing: legacyItem,
        update: { purchaseSnapshot: validSnapshot },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);
  });

  // 2. Value-to-NULL mutation is prohibited
  it('2. prohibits Value-to-NULL mutation (clearing or wiping established provenance)', () => {
    const establishedItem = {
      id: 'oi-est-1',
      originalLotId: 'lot-uuid-1',
      originalListingId: 'listing-uuid-1',
      purchaseSnapshot: validSnapshot,
    };

    // Attempt to clear originalLotId
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { originalLotId: null },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempt to clear originalListingId
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { originalListingId: null },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempt to clear purchaseSnapshot
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { purchaseSnapshot: null },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);
  });

  // 3. Value-to-different-value mutation is prohibited
  it('3. prohibits Value-to-different-value mutation on established provenance', () => {
    const establishedItem = {
      id: 'oi-est-1',
      originalLotId: 'lot-uuid-1',
      originalListingId: 'listing-uuid-1',
      purchaseSnapshot: validSnapshot,
    };

    // Attempt to alter lot ID
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { originalLotId: 'lot-uuid-different' },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempt to alter listing ID
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { originalListingId: 'listing-uuid-different' },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);

    // Attempt to alter snapshot contents
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: { purchaseSnapshot: { ...validSnapshot, unitPrice: '9999.00' } },
      }),
    ).toThrow(ProvenanceImmutabilityViolationError);
  });

  // 4. Unchanged provenance permits unrelated OrderItem updates
  it('4. permits unrelated OrderItem updates when provenance fields remain unchanged', () => {
    const establishedItem = {
      id: 'oi-est-1',
      originalLotId: 'lot-uuid-1',
      originalListingId: 'listing-uuid-1',
      purchaseSnapshot: validSnapshot,
    };

    // When update leaves provenance undefined or identical, no error is thrown
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: {
          originalLotId: 'lot-uuid-1',
          originalListingId: 'listing-uuid-1',
          purchaseSnapshot: validSnapshot,
        },
      }),
    ).not.toThrow();

    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: establishedItem.id,
        existing: establishedItem,
        update: {},
      }),
    ).not.toThrow();
  });

  // 5. Valid normalized monetary strings are accepted
  it('5. accepts valid normalized decimal strings for all monetary fields', () => {
    expect(validateMonetaryDecimalString('1500', 'unitPrice', false).toString()).toBe('1500');
    expect(validateMonetaryDecimalString('1500.00', 'unitPrice', false).toString()).toBe('1500');
    expect(validateMonetaryDecimalString('0.50', 'unitPrice', false).toString()).toBe('0.5');
    expect(validateMonetaryDecimalString('0', 'fee', true).toString()).toBe('0');
    expect(validateMonetaryDecimalString('0.00', 'fee', true).toString()).toBe('0');

    const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(validSnapshot);
    expect(validated.unitPrice).toBe('1500.00');
    expect(validated.selectedPreparationOption?.fee).toBe('200.00');
    expect(validated.ceilingConsent?.authorizedCeilingJmd).toBe('22000.00');
  });

  // 6. Floating-point monetary inputs are rejected
  it('6. rejects floating-point and numeric monetary inputs without silent conversion', () => {
    // Number type inputs must be rejected outright
    expect(() => validateMonetaryDecimalString(1500 as any, 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString(200.5 as any, 'fee', true)).toThrow(
      InvalidPurchaseSnapshotError,
    );

    const snapshotWithNumericPrice = {
      ...validSnapshot,
      unitPrice: 1500 as any,
    };
    expect(() =>
      SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(snapshotWithNumericPrice),
    ).toThrow(InvalidPurchaseSnapshotError);
  });

  // 7. Excessive decimal precision is rejected
  it('7. rejects excessive decimal precision beyond 2 decimal places', () => {
    expect(() => validateMonetaryDecimalString('1500.555', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('0.123', 'fee', true)).toThrow(
      InvalidPurchaseSnapshotError,
    );

    const snapshotWithExcessivePrecision = {
      ...validSnapshot,
      unitPrice: '1500.999',
    };
    expect(() =>
      SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(snapshotWithExcessivePrecision),
    ).toThrow(InvalidPurchaseSnapshotError);
  });

  // 8. Malformed and negative monetary values are rejected
  it('8. rejects negative amounts, scientific notation, NaN, Infinity, and malformed strings', () => {
    expect(() => validateMonetaryDecimalString('-10.00', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('1e3', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('1E-2', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('NaN', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('Infinity', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('10.', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('.50', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('015.00', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    expect(() => validateMonetaryDecimalString('abc', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
    // Non-zero required for unitPrice
    expect(() => validateMonetaryDecimalString('0.00', 'unitPrice', false)).toThrow(
      InvalidPurchaseSnapshotError,
    );
  });

  // 9. Snapshot and reference consistency remains enforced
  it('9. enforces cross-entity consistency between snapshot, listing, lot, and vendor', () => {
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertHybridProvenanceConsistency({
        orderItemId: 'oi-123',
        originalLotId: 'lot-uuid-1',
        originalListingId: 'listing-uuid-1',
        purchaseSnapshot: validSnapshot,
        listing: validListing,
        lot: validLot,
        expectedVendorId: 'vendor-uuid-1',
      }),
    ).not.toThrow();

    // Snapshot lot differs from column
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertHybridProvenanceConsistency({
        orderItemId: 'oi-123',
        originalLotId: 'lot-uuid-1',
        originalListingId: 'listing-uuid-1',
        purchaseSnapshot: { ...validSnapshot, originalLotId: 'lot-diff' },
        listing: validListing,
        lot: validLot,
        expectedVendorId: 'vendor-uuid-1',
      }),
    ).toThrow(ProvenanceConsistencyViolationError);

    // Cross-vendor listing
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertHybridProvenanceConsistency({
        orderItemId: 'oi-123',
        originalLotId: 'lot-uuid-1',
        originalListingId: 'listing-uuid-1',
        purchaseSnapshot: validSnapshot,
        listing: { ...validListing, vendorId: 'vendor-other' },
        lot: validLot,
        expectedVendorId: 'vendor-uuid-1',
      }),
    ).toThrow(ProvenanceConsistencyViolationError);
  });

  // 10. Legacy OrderItem records remain compatible
  it('10. preserves compatibility for legacy OrderItems with null provenance', () => {
    const legacyItem = {
      id: 'oi-legacy-1',
      originalLotId: null,
      originalListingId: null,
      purchaseSnapshot: null,
    };

    expect(legacyItem.originalLotId).toBeNull();
    expect(legacyItem.originalListingId).toBeNull();
    expect(legacyItem.purchaseSnapshot).toBeNull();

    // Updating non-provenance fields on legacy items (provenance remaining undefined or null) does not throw
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertProvenanceImmutability({
        orderItemId: legacyItem.id,
        existing: legacyItem,
        update: {
          originalLotId: null,
          originalListingId: null,
        },
      }),
    ).not.toThrow();

    // Rejects synthetic backfill attempts
    expect(() =>
      SeafoodPurchaseProvenanceValidator.assertNoSyntheticBackfill({
        isLegacyOrder: true,
        attemptingSynthesis: true,
      }),
    ).toThrow(SyntheticProvenanceForbiddenError);
  });

  // 11. WHOLE_RAW pricing basis preservation
  it('11. preserves the WHOLE_RAW business rule: pricing basis remains whole raw weight before cleaning', () => {
    expect(SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(validSnapshot)).toBe(true);

    const dressedSnapshot = {
      ...validSnapshot,
      pricingBasis: SeafoodPricingBasis.DRESSED,
    };
    expect(SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(dressedSnapshot)).toBe(false);
  });

  // 12. PostgreSQL Migration Trigger & Rollback SQL Invariant Verification
  it('12. verifies that migration.sql defines IS DISTINCT FROM trigger logic and rollback.sql has refusal guard', () => {
    const migrationDir = path.resolve(
      __dirname,
      '../../../../../prisma/migrations/20261025120000_phase_16d_wp41_order_item_provenance',
    );
    const migrationSqlPath = path.join(migrationDir, 'migration.sql');
    const rollbackSqlPath = path.join(migrationDir, 'rollback.sql');

    expect(fs.existsSync(migrationSqlPath)).toBe(true);
    expect(fs.existsSync(rollbackSqlPath)).toBe(true);

    const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
    // Verifies null-safe IS DISTINCT FROM trigger comparison
    expect(migrationSql).toContain('NEW."originalLotId" IS DISTINCT FROM OLD."originalLotId"');
    expect(migrationSql).toContain('NEW."originalListingId" IS DISTINCT FROM OLD."originalListingId"');
    expect(migrationSql).toContain('NEW."purchaseSnapshot"::text IS DISTINCT FROM OLD."purchaseSnapshot"::text');
    expect(migrationSql).toContain('trg_prevent_order_item_provenance_mutation');

    const rollbackSql = fs.readFileSync(rollbackSqlPath, 'utf8');
    expect(rollbackSql).toContain('BEGIN;');
    expect(rollbackSql).toContain('ROLLBACK REFUSED');
    expect(rollbackSql).toContain('ACCESS EXCLUSIVE');
    expect(rollbackSql).toContain('COMMIT;');
  });

  describe('Phase 16D WP4.3B.4B: Versioned Purchase Provenance (V2 Contract & Validator)', () => {
    const validV2Snapshot: SeafoodPurchaseSnapshotV2 = {
      schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
      originalLotId: 'lot-uuid-1',
      originalListingId: 'listing-uuid-1',
      vendorId: 'vendor-uuid-1',
      productId: 'product-uuid-1',
      productName: 'Yellowfin Tuna Whole',
      productDescription: 'Freshly caught Yellowfin Tuna',
      species: 'Thunnus albacares',
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      currency: 'JMD',
      unitPrice: '1500.00',
      unit: ProductUnit.PER_POUND,
      pieceCount: 1,
      fishCount: 1,
      originalWholeWeightLbs: 12.5,
      originalWholeWeightUnit: WeightUnit.POUNDS,
      estimatedWeightLbs: 12.5,
      selectedPreparationOption: {
        id: 'prep-gutted-scaled',
        name: 'Gutted & Scaled',
        chargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
        rate: '250.00',
        fee: '250.00',
        currency: 'JMD',
      },
      usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
      ceilingConsent: {
        authorizedCeilingJmd: '22000.00',
        termsVersion: 'v2026.1',
        quoteId: 'quote-uuid-abc-123',
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        consentedAt: '2026-10-25T12:00:00.000Z',
      },
      purchasedAt: '2026-10-25T12:00:00.000Z',
    };

    it('validates a correct SeafoodPurchaseSnapshotV2 with FIXED_PER_FISH preparation pricing', () => {
      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(validV2Snapshot);
      expect(validated.schemaVersion).toBe(2);
      expect((validated as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.chargeMethod).toBe(
        PreparationChargeMethod.FIXED_PER_FISH,
      );
    });

    it('validates a correct V2 snapshot with FIXED_PER_POUND preparation pricing in pounds', () => {
      // 10 lbs * 50.00/lb = 500.00
      const perPoundSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        originalWholeWeightLbs: 10.0,
        originalWholeWeightUnit: WeightUnit.POUNDS,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          fee: '500.00',
          currency: 'JMD',
        },
      };

      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(perPoundSnapshot);
      expect((validated as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.fee).toBe('500.00');
    });

    // Correction B Regression Test:
    // 10 lb at J$75/lb produces J$750.00 regardless of original measurement-unit metadata
    it('proves that 10 lb at J$75/lb produces J$750.00 regardless of original measurement-unit metadata (Correction B)', () => {
      // Case 1: originalWholeWeightUnit = POUNDS
      const poundsSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        originalWholeWeightLbs: 10.0,
        originalWholeWeightUnit: WeightUnit.POUNDS,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          fee: '750.00',
          currency: 'JMD',
        },
      };

      const validatedPounds = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(poundsSnapshot);
      expect((validatedPounds as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.fee).toBe('750.00');

      // Case 2: originalWholeWeightUnit = KILOGRAMS (metadata only; originalWholeWeightLbs is already normalized to pounds)
      const kgMetadataSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        originalWholeWeightLbs: 10.0,
        originalWholeWeightUnit: WeightUnit.KILOGRAMS,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          fee: '750.00',
          currency: 'JMD',
        },
      };

      const validatedKg = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(kgMetadataSnapshot);
      expect((validatedKg as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.fee).toBe('750.00');

      // Case 3: originalWholeWeightUnit undefined
      const undefinedUnitSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        originalWholeWeightLbs: 10.0,
        originalWholeWeightUnit: undefined,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '75.00',
          fee: '750.00',
          currency: 'JMD',
        },
      };

      const validatedUndefined = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(undefinedUnitSnapshot);
      expect((validatedUndefined as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.fee).toBe('750.00');
    });

    it('validates a correct V2 snapshot with NO_PREPARATION (0.00 fee and rate)', () => {
      const noPrepSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        selectedPreparationOption: {
          id: 'prep-none',
          name: 'No Preparation',
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0.00',
          fee: '0.00',
          currency: 'JMD',
        },
      };

      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(noPrepSnapshot);
      expect((validated as SeafoodPurchaseSnapshotV2).selectedPreparationOption?.fee).toBe('0.00');
    });

    it('validates a correct V2 snapshot without selectedPreparationOption', () => {
      const { selectedPreparationOption, ...snapshotWithoutPrep } = validV2Snapshot;
      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(snapshotWithoutPrep);
      expect((validated as SeafoodPurchaseSnapshotV2).selectedPreparationOption).toBeUndefined();
    });

    it('preserves species as optional in V2 snapshot', () => {
      const { species, ...snapshotWithoutSpecies } = validV2Snapshot;
      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(snapshotWithoutSpecies);
      expect(validated.species).toBeUndefined();
    });

    it('rejects V2 snapshot with FIXED_PER_FISH when fishCount is missing or non-positive integer', () => {
      const missingFishCount = {
        ...validV2Snapshot,
        fishCount: undefined,
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(missingFishCount),
      ).toThrow(InvalidPurchaseSnapshotError);

      const zeroFishCount = {
        ...validV2Snapshot,
        fishCount: 0,
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(zeroFishCount),
      ).toThrow(InvalidPurchaseSnapshotError);

      const fractionalFishCount = {
        ...validV2Snapshot,
        fishCount: 2.5,
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(fractionalFishCount),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot with FIXED_PER_POUND when originalWholeWeightLbs is missing or non-positive', () => {
      const missingWholeWeight: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        originalWholeWeightLbs: undefined,
        selectedPreparationOption: {
          id: 'prep-filleted',
          name: 'Filleted',
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          fee: '500.00',
          currency: 'JMD',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(missingWholeWeight),
      ).toThrow(InvalidPurchaseSnapshotError);

      const zeroWholeWeight = {
        ...missingWholeWeight,
        originalWholeWeightLbs: 0,
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(zeroWholeWeight),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when preparation fee does not match calculated formula', () => {
      // 1 fish * 250.00 = 250.00, but fee claimed is 300.00
      const mismatchedFeeSnapshot: SeafoodPurchaseSnapshotV2 = {
        ...validV2Snapshot,
        selectedPreparationOption: {
          ...validV2Snapshot.selectedPreparationOption!,
          fee: '300.00',
        },
      };

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(mismatchedFeeSnapshot),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot with invalid or unsupported chargeMethod', () => {
      const invalidMethodSnapshot = {
        ...validV2Snapshot,
        selectedPreparationOption: {
          ...validV2Snapshot.selectedPreparationOption!,
          chargeMethod: 'UNKNOWN_METHOD' as any,
        },
      };

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(invalidMethodSnapshot),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // Correction A: Mandatory V2 Consent Evidence
    // =========================================================================
    it('rejects V2 snapshot when ceilingConsent is missing (Correction A)', () => {
      const missingConsent = { ...validV2Snapshot };
      delete (missingConsent as any).ceilingConsent;

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(missingConsent),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when ceilingConsent is null or non-object (Correction A)', () => {
      const nullConsent = { ...validV2Snapshot, ceilingConsent: null as any };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(nullConsent),
      ).toThrow(InvalidPurchaseSnapshotError);

      const arrayConsent = { ...validV2Snapshot, ceilingConsent: [] as any };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(arrayConsent),
      ).toThrow(InvalidPurchaseSnapshotError);

      const stringConsent = { ...validV2Snapshot, ceilingConsent: 'invalid-string' as any };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(stringConsent),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when ceilingConsent authorizedCeilingJmd is zero, negative, or malformed (Correction A)', () => {
      const zeroCeiling = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, authorizedCeilingJmd: '0.00' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(zeroCeiling),
      ).toThrow(InvalidPurchaseSnapshotError);

      const negativeCeiling = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, authorizedCeilingJmd: '-100.00' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(negativeCeiling),
      ).toThrow(InvalidPurchaseSnapshotError);

      const malformedCeiling = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, authorizedCeilingJmd: '22000.555' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(malformedCeiling),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when ceilingConsent termsVersion is empty or whitespace (Correction A)', () => {
      const emptyTerms = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, termsVersion: '' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(emptyTerms),
      ).toThrow(InvalidPurchaseSnapshotError);

      const wsTerms = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, termsVersion: '   ' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(wsTerms),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // Correction C: Strict Preparation Currency ("JMD")
    // =========================================================================
    it('rejects V2 snapshot when selectedPreparationOption.currency is not strictly "JMD" (Correction C)', () => {
      const basePrep = validV2Snapshot.selectedPreparationOption!;

      // Lowercase
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...basePrep, currency: 'jmd' as any },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Mixed-case
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...basePrep, currency: 'Jmd' as any },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Padded
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...basePrep, currency: ' JMD ' as any },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Other currency
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...basePrep, currency: 'USD' as any },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when snapshot currency is not strictly "JMD" (Correction C)', () => {
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          currency: 'USD' as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          currency: 'jmd' as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // Correction D: Quote and Timestamp Validation
    // =========================================================================
    it('validates V2 snapshot with valid quoteId formats (Correction D)', () => {
      // UUID v4 format
      const uuidQuoteSnapshot = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          quoteId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(uuidQuoteSnapshot),
      ).not.toThrow();

      // Standard server quote identifier string
      const standardQuoteSnapshot = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          quoteId: 'fixed-quote-id',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(standardQuoteSnapshot),
      ).not.toThrow();
    });

    it('rejects V2 snapshot when ceilingConsent has missing, empty or whitespace quoteId (Correction D)', () => {
      const missingQuoteId = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, quoteId: '' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(missingQuoteId),
      ).toThrow(InvalidPurchaseSnapshotError);

      const whitespaceQuoteId = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, quoteId: '   ' },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(whitespaceQuoteId),
      ).toThrow(InvalidPurchaseSnapshotError);

      const nonStringQuoteId = {
        ...validV2Snapshot,
        ceilingConsent: { ...validV2Snapshot.ceilingConsent, quoteId: 12345 as any },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(nonStringQuoteId),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when ceilingConsent has malformed payloadHash', () => {
      const invalidHash = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          payloadHash: 'not-a-64-character-hex-digest',
        },
      };

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(invalidHash),
      ).toThrow(InvalidPurchaseSnapshotError);

      const shortHash = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85', // 63 chars
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(shortHash),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('validates V2 snapshot with valid ISO-8601 timestamps containing explicit timezone (Correction D)', () => {
      // UTC 'Z' format
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00.000Z',
          },
        }),
      ).not.toThrow();

      // Explicit offset '+00:00'
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00+00:00',
          },
        }),
      ).not.toThrow();

      // Negative offset '-05:00' (Jamaica time)
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T07:00:00-05:00',
          },
        }),
      ).not.toThrow();
    });

    it('rejects V2 snapshot when ceilingConsent consentedAt lacks an explicit timezone (Correction D)', () => {
      // Lacks timezone (no Z or offset)
      const noTimezoneSnapshot = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          consentedAt: '2026-10-25T12:00:00',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(noTimezoneSnapshot),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Date only
      const dateOnlySnapshot = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          consentedAt: '2026-10-25',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(dateOnlySnapshot),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot when ceilingConsent has invalid consentedAt timestamp', () => {
      const invalidTimestamp = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          consentedAt: 'invalid-iso-date',
        },
      };

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(invalidTimestamp),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // WP4.3B.4B.2 — Correction 1: Decimal Error Normalization
    // =========================================================================
    it('computeV2PreparationFee protects Decimal construction and rejects malformed whole-weight inputs with InvalidPurchaseSnapshotError (Correction 1)', () => {
      // Malformed string
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          originalWholeWeight: 'not-a-number' as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Non-finite value: NaN
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          originalWholeWeight: NaN,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Non-finite value: Infinity
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          originalWholeWeight: Infinity,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Zero weight
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          originalWholeWeight: 0,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Negative weight
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
          rate: '50.00',
          originalWholeWeight: -5.5,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Preserves valid canonical pounds calculation
      const validFee = computeV2PreparationFee({
        chargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
        rate: '75.00',
        originalWholeWeight: 10,
      });
      expect(validFee.toFixed(2)).toBe('750.00');
    });

    // =========================================================================
    // WP4.3B.4B.2 — Correction 2: Exact No-Preparation Rate ("0.00")
    // =========================================================================
    it('computeV2PreparationFee strictly requires literal "0.00" for NO_PREPARATION and rejects "0", "0.0", numeric 0, etc. (Correction 2)', () => {
      // Valid exact literal "0.00"
      expect(
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0.00',
        }).toFixed(2),
      ).toBe('0.00');

      // Rejects "0"
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0',
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects "0.0"
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0.0',
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects numeric 0
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: 0 as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects empty string
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '',
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects missing (undefined)
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: undefined as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects null
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: null as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects nonzero
      expect(() =>
        computeV2PreparationFee({
          chargeMethod: PreparationChargeMethod.NO_PREPARATION,
          rate: '0.01',
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects V2 snapshot with NO_PREPARATION when rate or fee is not literal "0.00" (Correction 2)', () => {
      const baseNoPrep = {
        id: 'prep-none',
        name: 'No Preparation',
        chargeMethod: PreparationChargeMethod.NO_PREPARATION,
        rate: '0.00',
        fee: '0.00',
        currency: 'JMD' as const,
      };

      // Rejects rate = "0"
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...baseNoPrep, rate: '0' },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects rate = "0.0"
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...baseNoPrep, rate: '0.0' },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects fee = "0"
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...baseNoPrep, fee: '0' },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects fee = "0.0"
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...baseNoPrep, fee: '0.0' },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Rejects numeric rate = 0
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: { ...baseNoPrep, rate: 0 as any },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // WP4.3B.4B.2 — Correction 3: Strict ISO-8601 Timestamp Validation
    // =========================================================================
    it('validates strictly formed ISO-8601 timestamps and preserves UTC and valid offsets (Correction 3)', () => {
      // Leap day in leap year (2024 is a leap year)
      const leapDaySnapshot = {
        ...validV2Snapshot,
        purchasedAt: '2024-02-29T12:00:00.000Z',
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          consentedAt: '2024-02-29T12:00:00.000Z',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(leapDaySnapshot),
      ).not.toThrow();

      // Valid timezone offset -05:00
      const offsetSnapshot = {
        ...validV2Snapshot,
        ceilingConsent: {
          ...validV2Snapshot.ceilingConsent,
          consentedAt: '2026-10-25T07:00:00-05:00',
        },
      };
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(offsetSnapshot),
      ).not.toThrow();
    });

    it('rejects impossible calendar dates in ISO-8601 timestamps (Correction 3)', () => {
      // Feb 29 in non-leap year (2026 is NOT a leap year)
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-02-29T12:00:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Feb 31
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-02-31T12:00:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // April 31 (April has 30 days)
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-04-31T12:00:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // November 31 (Nov has 30 days)
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-11-31T12:00:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects invalid clock values in ISO-8601 timestamps (Correction 3)', () => {
      // Hour 24
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T24:00:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Minute 60
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:60:00.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Second 60
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:60.000Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects invalid timezone offsets in ISO-8601 timestamps (Correction 3)', () => {
      // Missing timezone
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Offset hour 25
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00+25:00',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Offset minute 60
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00+05:60',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Incomplete offset (missing minutes)
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00+05',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects malformed fractional seconds in ISO-8601 timestamps (Correction 3)', () => {
      // Trailing dot with no digits
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00.Z',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // Non-numeric fractional seconds
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          ceilingConsent: {
            ...validV2Snapshot.ceilingConsent,
            consentedAt: '2026-10-25T12:00:00.abcZ',
          },
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects invalid purchasedAt timestamp in V2 snapshot (Correction 3)', () => {
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          purchasedAt: '2026-02-31T12:00:00.000Z',
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    // =========================================================================
    // WP4.3B.4B.2 — Correction 4: Optional Preparation Field
    // =========================================================================
    it('allows selectedPreparationOption to be omitted in V2 snapshot (Correction 4)', () => {
      const omittedPrep = { ...validV2Snapshot };
      delete (omittedPrep as any).selectedPreparationOption;

      const validated = SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(omittedPrep);
      expect((validated as SeafoodPurchaseSnapshotV2).selectedPreparationOption).toBeUndefined();
    });

    it('rejects V2 snapshot when selectedPreparationOption is null, string, number, or array (Correction 4)', () => {
      // null
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: null as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // string
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: 'prep-gutted-scaled' as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // number
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: 12345 as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);

      // array
      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure({
          ...validV2Snapshot,
          selectedPreparationOption: [] as any,
        }),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('rejects unsupported schema version', () => {
      const unsupportedVersion = {
        ...validV2Snapshot,
        schemaVersion: 99 as any,
      };

      expect(() =>
        SeafoodPurchaseProvenanceValidator.validatePurchaseSnapshotStructure(unsupportedVersion),
      ).toThrow(InvalidPurchaseSnapshotError);
    });

    it('verifies whole raw pricing rule works seamlessly for both V1 and V2 snapshots', () => {
      expect(SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(validSnapshot)).toBe(true);
      expect(SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(validV2Snapshot)).toBe(true);

      const dressedV2 = {
        ...validV2Snapshot,
        pricingBasis: SeafoodPricingBasis.DRESSED,
      };
      expect(SeafoodPurchaseProvenanceValidator.verifyWholeRawPricingRule(dressedV2)).toBe(false);
    });
  });
});
