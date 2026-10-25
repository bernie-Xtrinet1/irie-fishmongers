import * as fs from 'fs';
import * as path from 'path';
import { ProductUnit, SeafoodPricingBasis, UsablePartsPreference } from '@prisma/client';
import {
  InvalidPurchaseSnapshotError,
  ProvenanceConsistencyViolationError,
  ProvenanceImmutabilityViolationError,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SeafoodPurchaseSnapshotV1,
  SyntheticProvenanceForbiddenError,
} from '../seafood-purchase-provenance.types';
import {
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
});
