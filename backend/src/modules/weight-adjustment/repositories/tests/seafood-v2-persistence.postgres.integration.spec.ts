import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  Parish,
  PrismaClient,
  ProductUnit,
  RoleName,
  SeafoodPricingBasis,
  SeafoodStorageType,
  WeightUnit,
  PreparationChargeMethod,
  PreparationFeeStructure,
  UsablePartsPreference,
} from '@prisma/client';
import Decimal from 'decimal.js';
import {
  assertNativeClusterIsolation,
  DatabaseIsolationGuardError,
  executeRollbackScriptWithPsql,
  EXPECTED_DISPOSABLE_DB_NAME,
  EXPECTED_NATIVE_CLUSTER_PORT,
  EXPECTED_ROLLBACK_CLEAN_DB_NAME,
  EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
  EXPECTED_TEMPORARY_DATA_DIR,
  validateDatabaseIsolationUrl,
} from './test-database-isolation.helper';
import {
  PreparationChargeMethod as DomainPreparationChargeMethod,
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
  SeafoodPurchaseSnapshotV2,
} from '../../domain/seafood-purchase-provenance.types';
import { SeafoodOrderWeightAdjustmentRepository } from '../seafood-order-weight-adjustment.repository';
import { CustomerWeightConsentRepository } from '../customer-weight-consent.repository';
import {
  InvalidAdjustmentInputError,
  InvalidConsentInputError,
} from '../types/weight-adjustment-repository.types';

jest.setTimeout(60_000);

describe('Phase 16D WP4.3B.4C.1A: V2 Provenance & Consent Persistence (Disposable PostgreSQL)', () => {
  let prisma: PrismaClient;
  let adjustmentRepo: SeafoodOrderWeightAdjustmentRepository;
  let consentRepo: CustomerWeightConsentRepository;

  const migrationSqlPath = path.resolve(
    __dirname,
    '../../../../../prisma/migrations/20261103000000_phase_16d_wp43_v2_provenance_persistence/migration.sql',
  );
  const rollbackSqlPath = path.resolve(
    __dirname,
    '../../../../../prisma/migrations/20261103000000_phase_16d_wp43_v2_provenance_persistence/rollback.sql',
  );

  /**
   * Dynamically constructs connection details and auxiliary URLs from DATABASE_URL.
   * NEVER hard-codes passwords, tokens, or credentials in test source code.
   */
  function getAuxiliaryDbConnection(targetDbName: string) {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) {
      throw new DatabaseIsolationGuardError('DATABASE_URL is not set.');
    }
    const parsed = new URL(rawUrl);
    const host = parsed.hostname || '127.0.0.1';
    const port = parsed.port ? parseInt(parsed.port, 10) : EXPECTED_NATIVE_CLUSTER_PORT;
    const user = parsed.username || process.env.PGUSER || 'irie_wp42b_admin';
    const password = parsed.password || process.env.PGPASSWORD || undefined;

    // Build auxiliary connection URL with target db
    const authPrefix = user ? `${user}${password ? `:${password}` : ''}@` : '';
    const auxiliaryUrl = `${parsed.protocol}//${authPrefix}${host}:${port}/${targetDbName}${parsed.search || '?schema=public'}`;

    return {
      auxiliaryUrl,
      host,
      port,
      user,
      password,
    };
  }

  beforeAll(async () => {
    // 1. Validate environment isolation guard
    const rawUrl = process.env.DATABASE_URL;
    const isolationReport = validateDatabaseIsolationUrl(rawUrl, {
      expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
      expectedDbName: EXPECTED_DISPOSABLE_DB_NAME,
      requireLoopback: true,
    });

    if (!isolationReport.isIsolated) {
      throw new DatabaseIsolationGuardError(
        `Database isolation check failed: ${isolationReport.violations.join('; ')}`,
      );
    }

    // 2. Verify explicit migration authorization
    if (process.env.MIGRATION_EXECUTION_AUTHORIZED !== 'true') {
      throw new DatabaseIsolationGuardError(
        'Migration execution authorization has not been granted (MIGRATION_EXECUTION_AUTHORIZED !== "true"). Failing closed per safety protocol.',
      );
    }

    prisma = new PrismaClient({
      datasources: { db: { url: rawUrl } },
    });

    await prisma.$connect();

    // 3. Assert live native cluster isolation invariants
    await assertNativeClusterIsolation(prisma, {
      expectedDbName: EXPECTED_DISPOSABLE_DB_NAME,
      expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
      expectedDataDir: EXPECTED_TEMPORARY_DATA_DIR,
      allowNonEmpty: true,
    });

    adjustmentRepo = new SeafoodOrderWeightAdjustmentRepository(prisma as any);
    consentRepo = new CustomerWeightConsentRepository(prisma as any);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  // Helper to generate a valid mock SeafoodPurchaseSnapshotV2
  function createSampleV2Snapshot(overrides?: Partial<SeafoodPurchaseSnapshotV2>): SeafoodPurchaseSnapshotV2 {
    return {
      schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION_V2,
      originalLotId: overrides?.originalLotId ?? `lot-${randomUUID()}`,
      originalListingId: overrides?.originalListingId ?? `listing-${randomUUID()}`,
      vendorId: overrides?.vendorId ?? `vendor-${randomUUID()}`,
      productId: overrides?.productId ?? `prod-${randomUUID()}`,
      productName: overrides?.productName ?? 'Yellowfin Tuna Steak',
      pricingBasis: overrides?.pricingBasis ?? SeafoodPricingBasis.WHOLE_RAW,
      currency: 'JMD',
      unitPrice: overrides?.unitPrice ?? '1500.00',
      unit: overrides?.unit ?? ProductUnit.PER_POUND,
      pieceCount: overrides?.pieceCount ?? 1,
      fishCount: overrides?.fishCount ?? 2,
      originalWholeWeightLbs: overrides?.originalWholeWeightLbs ?? 10.0,
      originalWholeWeightUnit: overrides?.originalWholeWeightUnit ?? WeightUnit.POUNDS,
      selectedPreparationOption: overrides?.selectedPreparationOption ?? {
        id: 'prep-clean',
        name: 'Clean and Scale',
        chargeMethod: DomainPreparationChargeMethod.FIXED_PER_FISH,
        rate: '150.00',
        fee: '300.00',
        currency: 'JMD',
      },
      usablePartsPreference: overrides?.usablePartsPreference ?? UsablePartsPreference.RETURN_USABLE_PARTS,
      ceilingConsent: overrides?.ceilingConsent ?? {
        authorizedCeilingJmd: '3500.00',
        termsVersion: '2026-10-v2',
        quoteId: `quote-${randomUUID()}`,
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        consentedAt: new Date().toISOString(),
      },
      purchasedAt: overrides?.purchasedAt ?? new Date().toISOString(),
    };
  }

  // Seed minimum prerequisite records for FK satisfaction
  async function seedPrerequisites(client: PrismaClient) {
    const nonce = randomUUID().substring(0, 8);

    await client.role.upsert({ where: { name: RoleName.CUSTOMER }, update: {}, create: { name: RoleName.CUSTOMER } });
    await client.role.upsert({ where: { name: RoleName.VENDOR }, update: {}, create: { name: RoleName.VENDOR } });

    const user = await client.user.create({
      data: {
        email: `tester-${nonce}@disposable.local`,
        passwordHash: 'dummy-hashed-secret-value-for-testing',
        firstName: 'Test',
        lastName: `Customer ${nonce}`,
        phone: '876-555-0199',
        roles: { create: { role: { connect: { name: RoleName.CUSTOMER } } } },
      },
    });

    const vendorUser = await client.user.create({
      data: {
        email: `vendor-${nonce}@disposable.local`,
        passwordHash: 'dummy-hashed-secret-value-for-testing',
        firstName: 'Test',
        lastName: `Vendor ${nonce}`,
        phone: '876-555-0200',
        roles: { create: { role: { connect: { name: RoleName.VENDOR } } } },
      },
    });

    const vendor = await client.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Irie Fishery ${nonce}`,
        description: 'Test disposable vendor',
        parish: Parish.KINGSTON,
        phone: '876-555-0200',
        termsAcceptedAt: new Date(),
      },
    });

    const category = await client.category.create({
      data: {
        name: `Pelagic Fish ${nonce}`,
        slug: `pelagic-fish-${nonce}`,
      },
    });

    const catalogueItem = await client.seafoodCatalogueItem.create({
      data: {
        name: `Yellowfin Tuna ${nonce}`,
        commonName: 'Yellowfin Tuna',
        scientificName: 'Thunnus albacares',
        categoryId: category.id,
      },
    });

    const lot = await client.seafoodLot.create({
      data: {
        lotNumber: `LOT-${nonce}`,
        publicTraceToken: randomUUID(),
        vendorId: vendor.id,
        species: 'Thunnus albacares',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: '150.00',
        weightUnit: WeightUnit.POUNDS,
      },
    });

    const product = await client.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        name: `Yellowfin Tuna Steak ${nonce}`,
        description: 'Fresh wild-caught tuna steaks',
        unit: ProductUnit.PER_POUND,
        price: '1500.00',
        quantityAvailable: 50,
        imageUrl: 'https://images.iriefishmongers.com/tuna.jpg',
      },
    });

    const listing = await client.vendorDailyListing.create({
      data: {
        vendorId: vendor.id,
        productId: product.id,
        lotId: lot.id,
        catalogueItemId: catalogueItem.id,
        listingTitle: `Daily Listing ${nonce}`,
        catchDate: new Date(),
        availableFrom: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        unit: ProductUnit.PER_POUND,
        price: '1500.00',
        currency: 'JMD',
        quantityUploaded: '50.00',
        quantityAvailable: '50.00',
      },
    });

    const order = await client.order.create({
      data: {
        customerId: user.id,
        deliveryAddressLine1: '45 Port Royal Street',
        deliveryParish: Parish.KINGSTON,
        deliveryPhone: '876-555-0199',
        currency: 'JMD',
      },
    });

    const vendorOrder = await client.vendorOrder.create({
      data: {
        orderId: order.id,
        vendorId: vendor.id,
        subtotal: '3000.00',
      },
    });

    return { user, vendor, category, catalogueItem, lot, product, listing, order, vendorOrder };
  }

  // ==========================================================================
  // SCENARIO 1: DDL & Schema Verification
  // ==========================================================================
  it('Scenario 1: verifies DDL columns, enum, and index exist in PostgreSQL catalog', async () => {
    // 1. Verify PreparationChargeMethod enum
    const enumTypes: Array<{ typname: string }> = await prisma.$queryRaw`
      SELECT typname FROM pg_type WHERE typname = 'PreparationChargeMethod';
    `;
    expect(enumTypes).toHaveLength(1);

    // 2. Verify seafood_order_weight_adjustments columns
    const adjColumns: Array<{ column_name: string; data_type: string; is_nullable: string; numeric_scale: number | null }> = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'seafood_order_weight_adjustments'
        AND column_name IN ('preparationChargeMethod', 'fishCount', 'originalWholeWeightLbs', 'originalWholeWeightUnit');
    `;
    expect(adjColumns).toHaveLength(4);

    const chargeMethodCol = adjColumns.find((c) => c.column_name === 'preparationChargeMethod');
    expect(chargeMethodCol?.is_nullable).toBe('YES');

    const fishCountCol = adjColumns.find((c) => c.column_name === 'fishCount');
    expect(fishCountCol?.is_nullable).toBe('YES');
    expect(fishCountCol?.data_type).toBe('integer');

    const weightCol = adjColumns.find((c) => c.column_name === 'originalWholeWeightLbs');
    expect(weightCol?.is_nullable).toBe('YES');
    expect(weightCol?.data_type).toBe('numeric');
    expect(weightCol?.numeric_scale).toBe(8);

    const unitCol = adjColumns.find((c) => c.column_name === 'originalWholeWeightUnit');
    expect(unitCol?.is_nullable).toBe('YES');

    // 3. Verify customer_checkout_ceiling_consents columns
    const consentColumns: Array<{ column_name: string; data_type: string; is_nullable: string }> = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'customer_checkout_ceiling_consents'
        AND column_name IN ('quoteId', 'quotePayloadHash');
    `;
    expect(consentColumns).toHaveLength(2);
    expect(consentColumns.find((c) => c.column_name === 'quoteId')?.is_nullable).toBe('YES');
    expect(consentColumns.find((c) => c.column_name === 'quotePayloadHash')?.is_nullable).toBe('YES');

    // 4. Verify index exists
    const indexes: Array<{ indexname: string }> = await prisma.$queryRaw`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'customer_checkout_ceiling_consents'
        AND indexname = 'idx_ceiling_consents_quote_id';
    `;
    expect(indexes).toHaveLength(1);
  });

  // ==========================================================================
  // SCENARIO 2: V1 Compatibility & Null V2 Fields
  // ==========================================================================
  it('Scenario 2: proves V1 historical orders persist with null V2 fields and valid adjustment hash', async () => {
    const fixture = await seedPrerequisites(prisma);

    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const adjustment = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: orderItem.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      pieceCount: 1,
      estimatedBillableWeight: '2.500',
      preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
      preparationFeeRate: '0.00',
      estimatedPreparationFee: '0.00',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
      // V2 fields deliberately omitted (null)
    });

    expect(adjustment.preparationChargeMethod).toBeNull();
    expect(adjustment.fishCount).toBeNull();
    expect(adjustment.originalWholeWeightLbs).toBeNull();
    expect(adjustment.originalWholeWeightUnit).toBeNull();

    const consent = await consentRepo.recordCheckoutCeilingConsent({
      weightAdjustmentId: adjustment.id,
      authenticatedCustomerId: fixture.user.id,
      initialEstimatedWeight: '2.500',
      initialEstimatedTotal: '3750.00',
      authorizedCeilingJmd: '4000.00',
      termsVersion: '2026-10-v1',
      // quoteId and quotePayloadHash deliberately omitted (null)
    });

    expect(consent.quoteId).toBeNull();
    expect(consent.quotePayloadHash).toBeNull();
    expect(consent.payloadHash).toBeDefined();
    expect(consent.payloadHash).toHaveLength(64);
  });

  // ==========================================================================
  // SCENARIO 3: V2 Preparation Method & Canonical Whole Weight Persistence
  // ==========================================================================
  it('Scenario 3: persists and retrieves V2 preparation charge method and whole weight with 8-decimal precision', async () => {
    const fixture = await seedPrerequisites(prisma);

    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    // 1.250 kg * 2.20462 = 2.75577500 lbs
    const unroundedWeightLbs = new Decimal('1.250').times(new Decimal('2.20462'));

    const adjustment = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: orderItem.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      pieceCount: 3,
      estimatedBillableWeight: '2.756',
      preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
      fishCount: 3,
      originalWholeWeightLbs: unroundedWeightLbs,
      originalWholeWeightUnit: WeightUnit.KILOGRAMS,
      preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
      preparationFeeRate: '450.00',
      estimatedPreparationFee: '450.00',
      estimatedProductSubtotal: '4133.66',
      estimatedItemTotal: '4583.66',
      customerAuthorizedCeilingJmd: '5000.00',
    });

    expect(adjustment.preparationChargeMethod).toBe(PreparationChargeMethod.FIXED_PER_FISH);
    expect(adjustment.fishCount).toBe(3);
    expect(adjustment.originalWholeWeightUnit).toBe(WeightUnit.KILOGRAMS);
    expect(new Decimal(adjustment.originalWholeWeightLbs!.toString()).toFixed(8)).toBe('2.75577500');

    // Retrieve via findById
    const loaded = await adjustmentRepo.findById(adjustment.id);
    expect(loaded?.preparationChargeMethod).toBe(PreparationChargeMethod.FIXED_PER_FISH);
    expect(loaded?.fishCount).toBe(3);
    expect(loaded?.originalWholeWeightLbs?.toString()).toBe('2.755775');

    // Verify exact round-trip for largest representable valid value within DECIMAL(16,8)
    const orderItemMax = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: `${fixture.product.name} (Max Weight Test)`,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const maxRepresentableWeight = '99999999.99999999';
    const maxAdjustment = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: orderItemMax.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '2.500',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
      originalWholeWeightLbs: maxRepresentableWeight,
      originalWholeWeightUnit: WeightUnit.POUNDS,
    });
    expect(maxAdjustment.originalWholeWeightLbs?.toString()).toBe(maxRepresentableWeight);
    const loadedMax = await adjustmentRepo.findById(maxAdjustment.id);
    expect(loadedMax?.originalWholeWeightLbs?.toString()).toBe(maxRepresentableWeight);
  });

  // ==========================================================================
  // SCENARIO 4: V2 Quote ID & Quote Payload Hash Persistence
  // ==========================================================================
  it('Scenario 4: persists quoteId and quotePayloadHash while preserving internal payloadHash', async () => {
    const fixture = await seedPrerequisites(prisma);

    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const adjustment = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: orderItem.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '2.500',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
    });

    const quoteId = `quote-${randomUUID()}`;
    const quotePayloadHash = 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123';

    const consent = await consentRepo.recordCheckoutCeilingConsent({
      weightAdjustmentId: adjustment.id,
      authenticatedCustomerId: fixture.user.id,
      initialEstimatedWeight: '2.500',
      initialEstimatedTotal: '3750.00',
      authorizedCeilingJmd: '4000.00',
      termsVersion: '2026-10-v2',
      quoteId,
      quotePayloadHash,
    });

    expect(consent.quoteId).toBe(quoteId);
    expect(consent.quotePayloadHash).toBe(quotePayloadHash);
    expect(consent.payloadHash).toBeDefined();
    expect(consent.payloadHash).not.toBe(quotePayloadHash); // Distinct from quote digest

    // Collection lookup by quoteId
    const foundByQuote = await consentRepo.findCheckoutConsentsByQuoteId(quoteId);
    expect(foundByQuote).toHaveLength(1);
    expect(foundByQuote[0]?.id).toBe(consent.id);
    expect(foundByQuote[0]?.weightAdjustmentId).toBe(adjustment.id);

    // Scoped lookup by adjustment and quote
    const foundScoped = await consentRepo.findCheckoutConsentByAdjustmentAndQuoteId(adjustment.id, quoteId);
    expect(foundScoped?.id).toBe(consent.id);
  });

  // ==========================================================================
  // SCENARIO 5: Database Immutability Trigger on V2 Purchase Snapshot
  // ==========================================================================
  it('Scenario 5: proves database trigger prevents any update to V2 purchase snapshots in order_items', async () => {
    const fixture = await seedPrerequisites(prisma);
    const snapshot = createSampleV2Snapshot({
      originalLotId: fixture.lot.id,
      originalListingId: fixture.listing.id,
      vendorId: fixture.vendor.id,
      productId: fixture.product.id,
    });

    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: snapshot as unknown as object,
      },
    });

    // Attempting to modify purchaseSnapshot must be rejected by prevent_order_item_provenance_mutation()
    const mutatedSnapshot = { ...snapshot, pieceCount: 99 };
    await expect(
      prisma.orderItem.update({
        where: { id: orderItem.id },
        data: { purchaseSnapshot: mutatedSnapshot as unknown as object },
      }),
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);

    // Unrelated update (e.g. quantity) with identical purchaseSnapshot must succeed
    const updated = await prisma.orderItem.update({
      where: { id: orderItem.id },
      data: { quantity: 2 },
    });
    expect(updated.quantity).toBe(2);
  });

  // ==========================================================================
  // SCENARIO 6A: Rollback Refusal Guard 1 (OrderItem V2 Snapshot Exists)
  // ==========================================================================
  it('Scenario 6A: proves rollback.sql aborts when order_items contains V2 purchase snapshot', async () => {
    const conn = getAuxiliaryDbConnection(EXPECTED_ROLLBACK_REFUSAL_DB_NAME);
    const refusalPrisma = new PrismaClient({
      datasources: { db: { url: conn.auxiliaryUrl } },
    });

    try {
      await refusalPrisma.$connect();
      await assertNativeClusterIsolation(refusalPrisma, {
        expectedDbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
        expectedDataDir: EXPECTED_TEMPORARY_DATA_DIR,
        allowNonEmpty: true,
      });

      const fixture = await seedPrerequisites(refusalPrisma);
      const v2Snapshot = createSampleV2Snapshot({
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        vendorId: fixture.vendor.id,
        productId: fixture.product.id,
      });

      const item = await refusalPrisma.orderItem.create({
        data: {
          vendorOrderId: fixture.vendorOrder.id,
          productId: fixture.product.id,
          productName: fixture.product.name,
          unitPrice: '1500.00',
          unit: ProductUnit.PER_POUND,
          quantity: 1,
          subtotal: '1500.00',
          currency: 'JMD',
          originalLotId: fixture.lot.id,
          originalListingId: fixture.listing.id,
          purchaseSnapshot: v2Snapshot as unknown as object,
        },
      });

      await refusalPrisma.$disconnect();

      // Execute rollback.sql against refusal database
      expect(fs.existsSync(rollbackSqlPath)).toBe(true);
      const rollbackResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        rollbackSqlPath,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
      });

      expect(rollbackResult.exitCode).not.toBe(0);
      expect(rollbackResult.stderr).toMatch(/ROLLBACK REFUSED: order_items contains \d+ records with V2 purchase snapshots/i);

      // Clean up the blocking item
      await refusalPrisma.$connect();
      await refusalPrisma.orderItem.delete({ where: { id: item.id } });
    } finally {
      await refusalPrisma.$disconnect();
    }
  });

  // ==========================================================================
  // SCENARIO 6B: Rollback Refusal Guard 2 (Adjustment V2 Fields Populated)
  // ==========================================================================
  it('Scenario 6B: proves rollback.sql aborts when seafood_order_weight_adjustments contains V2 fields', async () => {
    const conn = getAuxiliaryDbConnection(EXPECTED_ROLLBACK_REFUSAL_DB_NAME);
    const refusalPrisma = new PrismaClient({
      datasources: { db: { url: conn.auxiliaryUrl } },
    });

    try {
      await refusalPrisma.$connect();
      const fixture = await seedPrerequisites(refusalPrisma);

      const orderItem = await refusalPrisma.orderItem.create({
        data: {
          vendorOrderId: fixture.vendorOrder.id,
          productId: fixture.product.id,
          productName: fixture.product.name,
          unitPrice: '1500.00',
          unit: ProductUnit.PER_POUND,
          quantity: 1,
          subtotal: '1500.00',
        },
      });

      const adjustment = await refusalPrisma.seafoodOrderWeightAdjustment.create({
        data: {
          orderItemId: orderItem.id,
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          unitPrice: '1500.00',
          pieceCount: 1,
          estimatedBillableWeight: '2.500',
          estimatedProductSubtotal: '3750.00',
          estimatedItemTotal: '3750.00',
          customerAuthorizedCeilingJmd: '4000.00',
          // Populated V2 field
          preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
          fishCount: 2,
        },
      });

      await refusalPrisma.$disconnect();

      const rollbackResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        rollbackSqlPath,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
      });

      expect(rollbackResult.exitCode).not.toBe(0);
      expect(rollbackResult.stderr).toMatch(/ROLLBACK REFUSED: seafood_order_weight_adjustments contains \d+ records with populated V2 fields/i);

      // Clean up
      await refusalPrisma.$connect();
      await refusalPrisma.seafoodOrderWeightAdjustment.delete({ where: { id: adjustment.id } });
      await refusalPrisma.orderItem.delete({ where: { id: orderItem.id } });
    } finally {
      await refusalPrisma.$disconnect();
    }
  });

  // ==========================================================================
  // SCENARIO 6C: Rollback Refusal Guard 3 (Consent V2 Quote Fields Populated)
  // ==========================================================================
  it('Scenario 6C: proves rollback.sql aborts when customer_checkout_ceiling_consents contains quoteId or quotePayloadHash', async () => {
    const conn = getAuxiliaryDbConnection(EXPECTED_ROLLBACK_REFUSAL_DB_NAME);
    const refusalPrisma = new PrismaClient({
      datasources: { db: { url: conn.auxiliaryUrl } },
    });

    try {
      await refusalPrisma.$connect();
      const fixture = await seedPrerequisites(refusalPrisma);

      const orderItem = await refusalPrisma.orderItem.create({
        data: {
          vendorOrderId: fixture.vendorOrder.id,
          productId: fixture.product.id,
          productName: fixture.product.name,
          unitPrice: '1500.00',
          unit: ProductUnit.PER_POUND,
          quantity: 1,
          subtotal: '1500.00',
        },
      });

      const adjustment = await refusalPrisma.seafoodOrderWeightAdjustment.create({
        data: {
          orderItemId: orderItem.id,
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          unitPrice: '1500.00',
          pieceCount: 1,
          estimatedBillableWeight: '2.500',
          estimatedProductSubtotal: '3750.00',
          estimatedItemTotal: '3750.00',
          customerAuthorizedCeilingJmd: '4000.00',
          // Only V1 fields on adjustment
        },
      });

      const consent = await refusalPrisma.customerCheckoutCeilingConsent.create({
        data: {
          weightAdjustmentId: adjustment.id,
          authenticatedCustomerId: fixture.user.id,
          initialEstimatedWeight: '2.500',
          initialEstimatedTotal: '3750.00',
          authorizedCeilingJmd: '4000.00',
          termsVersion: '2026-10-v2',
          payloadHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          quoteId: 'quote-blocking-test-123',
          quotePayloadHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      });

      await refusalPrisma.$disconnect();

      const rollbackResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        rollbackSqlPath,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
      });

      expect(rollbackResult.exitCode).not.toBe(0);
      expect(rollbackResult.stderr).toMatch(/ROLLBACK REFUSED: customer_checkout_ceiling_consents contains \d+ records with populated quoteId or quotePayloadHash/i);

      // Clean up
      await refusalPrisma.$connect();
      await refusalPrisma.customerCheckoutCeilingConsent.delete({ where: { id: consent.id } });
      await refusalPrisma.seafoodOrderWeightAdjustment.delete({ where: { id: adjustment.id } });
      await refusalPrisma.orderItem.delete({ where: { id: orderItem.id } });
    } finally {
      await refusalPrisma.$disconnect();
    }
  });

  // ==========================================================================
  // SCENARIO 6D: Clean Rollback Success (Unpopulated Auxiliary DB)
  // ==========================================================================
  it('Scenario 6D: proves rollback.sql executes cleanly and drops V2 columns when no V2 data exists', async () => {
    const conn = getAuxiliaryDbConnection(EXPECTED_ROLLBACK_CLEAN_DB_NAME);
    const cleanPrisma = new PrismaClient({
      datasources: { db: { url: conn.auxiliaryUrl } },
    });

    try {
      await cleanPrisma.$connect();
      await assertNativeClusterIsolation(cleanPrisma, {
        expectedDbName: EXPECTED_ROLLBACK_CLEAN_DB_NAME,
        expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
        expectedDataDir: EXPECTED_TEMPORARY_DATA_DIR,
        allowNonEmpty: true,
      });

      await cleanPrisma.$disconnect();

      // Execute rollback.sql against clean auxiliary database
      const rollbackResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_CLEAN_DB_NAME,
        rollbackSqlPath,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
      });

      expect(rollbackResult.exitCode).toBe(0);

      // Reconnect and verify columns and types are dropped
      await cleanPrisma.$connect();

      const remainingAdjCols: Array<{ column_name: string }> = await cleanPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'seafood_order_weight_adjustments'
          AND column_name IN ('preparationChargeMethod', 'fishCount', 'originalWholeWeightLbs', 'originalWholeWeightUnit');
      `;
      expect(remainingAdjCols).toHaveLength(0);

      const remainingConsentCols: Array<{ column_name: string }> = await cleanPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'customer_checkout_ceiling_consents'
          AND column_name IN ('quoteId', 'quotePayloadHash');
      `;
      expect(remainingConsentCols).toHaveLength(0);

      const remainingEnum: Array<{ typname: string }> = await cleanPrisma.$queryRaw`
        SELECT typname FROM pg_type WHERE typname = 'PreparationChargeMethod';
      `;
      expect(remainingEnum).toHaveLength(0);

      // Verify V1 columns remain completely intact
      const preservedV1Cols: Array<{ column_name: string }> = await cleanPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'seafood_order_weight_adjustments'
          AND column_name IN ('id', 'orderItemId', 'pricingBasis', 'unit', 'unitPrice', 'pieceCount', 'estimatedBillableWeight', 'customerAuthorizedCeilingJmd');
      `;
      expect(preservedV1Cols).toHaveLength(8);
    } finally {
      await cleanPrisma.$disconnect();
      // Re-apply migration.sql so auxiliary clean database remains in a consistent ready state
      executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_CLEAN_DB_NAME,
        rollbackSqlPath: migrationSqlPath,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
      });
    }
  });

  // ==========================================================================
  // SCENARIO 7: Repository Structural Validation for V2 Adjustments
  // ==========================================================================
  it('Scenario 7: rejects inconsistent V2 adjustment inputs with InvalidAdjustmentInputError', async () => {
    const fixture = await seedPrerequisites(prisma);
    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const baseInput = {
      orderItemId: orderItem.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '2.500',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
    };

    // 1. FIXED_PER_FISH requires fishCount
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 2. fishCount must be a positive integer
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
        fishCount: 0,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
        fishCount: -2,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_FISH,
        fishCount: 1.5,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 3. FIXED_PER_POUND requires originalWholeWeightLbs and originalWholeWeightUnit
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.FIXED_PER_POUND,
        originalWholeWeightLbs: '10.5',
        // missing originalWholeWeightUnit
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 4. originalWholeWeightLbs must be positive, finite, and conform to DECIMAL(16,8) representability contract
    const countBeforeRejections = await prisma.seafoodOrderWeightAdjustment.count();

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        originalWholeWeightLbs: '-5.0',
        originalWholeWeightUnit: WeightUnit.POUNDS,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        originalWholeWeightLbs: 'invalid-number',
        originalWholeWeightUnit: WeightUnit.POUNDS,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 4a. Reject values requiring more than 8 fractional decimal places (e.g. 2.755775009)
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        originalWholeWeightLbs: '2.755775009',
        originalWholeWeightUnit: WeightUnit.POUNDS,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 4b. Reject values exceeding the DECIMAL(16,8) integer capacity (strictly < 100,000,000)
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        originalWholeWeightLbs: '100000000',
        originalWholeWeightUnit: WeightUnit.POUNDS,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        originalWholeWeightLbs: '123456789.12345678',
        originalWholeWeightUnit: WeightUnit.POUNDS,
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);

    // 4c. Verify all rejected adjustment attempts produced exactly ZERO database writes
    const countAfterRejections = await prisma.seafoodOrderWeightAdjustment.count();
    expect(countAfterRejections).toBe(countBeforeRejections);

    // 5. NO_PREPARATION requires 0.00 preparation fee
    await expect(
      adjustmentRepo.createAdjustmentSnapshot({
        ...baseInput,
        preparationChargeMethod: PreparationChargeMethod.NO_PREPARATION,
        estimatedPreparationFee: '150.00',
      }),
    ).rejects.toThrow(InvalidAdjustmentInputError);
  });

  // ==========================================================================
  // SCENARIO 8: Repository Structural Validation for V2 Consents
  // ==========================================================================
  it('Scenario 8: rejects incomplete or malformed quote fields with InvalidConsentInputError', async () => {
    const fixture = await seedPrerequisites(prisma);
    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const adjustment = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: orderItem.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '2.500',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
    });

    const baseConsent = {
      weightAdjustmentId: adjustment.id,
      authenticatedCustomerId: fixture.user.id,
      initialEstimatedWeight: '2.500',
      initialEstimatedTotal: '3750.00',
      authorizedCeilingJmd: '4000.00',
      termsVersion: '2026-10-v2',
    };

    // 1. quoteId provided without quotePayloadHash
    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: 'quote-12345',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    // 2. quotePayloadHash provided without quoteId
    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quotePayloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    // 3. Blank or whitespace-only quoteId is rejected
    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: '   ',
        quotePayloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: '',
        quotePayloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    // 4. Blank or whitespace-only quotePayloadHash is rejected
    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: 'quote-12345',
        quotePayloadHash: '   ',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: 'quote-12345',
        quotePayloadHash: '',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    // 5. Short / malformed / non-hex hash is rejected
    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: 'quote-12345',
        quotePayloadHash: 'short-non-hex-digest',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    await expect(
      consentRepo.recordCheckoutCeilingConsent({
        ...baseConsent,
        quoteId: 'quote-12345',
        quotePayloadHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      }),
    ).rejects.toThrow(InvalidConsentInputError);

    // 6. Mixed-case quote-hash compatibility: valid mixed-case 64-char hex is accepted and persisted
    const mixedCaseHash = '7D793037A0760186574b0282f2f435e7b1e50774690571317618165d0f480fed';
    const validConsent = await consentRepo.recordCheckoutCeilingConsent({
      ...baseConsent,
      quoteId: 'quote-mixed-case-123',
      quotePayloadHash: mixedCaseHash,
    });
    expect(validConsent.quoteId).toBe('quote-mixed-case-123');
    expect(validConsent.quotePayloadHash).toBe(mixedCaseHash);
  });

  // ==========================================================================
  // SCENARIO 9: Multi-Item Quote Supports Multiple Consents
  // ==========================================================================
  it('Scenario 9: proves a single quoteId legitimately supports multiple consent records', async () => {
    const fixture = await seedPrerequisites(prisma);

    // Two seafood order items in the same order
    const item1 = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: `${fixture.product.name} #1`,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const item2 = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: `${fixture.product.name} #2`,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 1,
        subtotal: '1500.00',
      },
    });

    const adj1 = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: item1.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '2.500',
      estimatedProductSubtotal: '3750.00',
      estimatedItemTotal: '3750.00',
      customerAuthorizedCeilingJmd: '4000.00',
    });

    const adj2 = await adjustmentRepo.createAdjustmentSnapshot({
      orderItemId: item2.id,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: '1500.00',
      estimatedBillableWeight: '3.000',
      estimatedProductSubtotal: '4500.00',
      estimatedItemTotal: '4500.00',
      customerAuthorizedCeilingJmd: '5000.00',
    });

    const sharedQuoteId = `multi-quote-${randomUUID()}`;
    const sharedQuotePayloadHash = '7d793037a0760186574b0282f2f435e7b1e50774690571317618165d0f480fed';

    const consent1 = await consentRepo.recordCheckoutCeilingConsent({
      weightAdjustmentId: adj1.id,
      authenticatedCustomerId: fixture.user.id,
      initialEstimatedWeight: '2.500',
      initialEstimatedTotal: '3750.00',
      authorizedCeilingJmd: '4000.00',
      termsVersion: '2026-10-v2',
      quoteId: sharedQuoteId,
      quotePayloadHash: sharedQuotePayloadHash,
    });

    const consent2 = await consentRepo.recordCheckoutCeilingConsent({
      weightAdjustmentId: adj2.id,
      authenticatedCustomerId: fixture.user.id,
      initialEstimatedWeight: '3.000',
      initialEstimatedTotal: '4500.00',
      authorizedCeilingJmd: '5000.00',
      termsVersion: '2026-10-v2',
      quoteId: sharedQuoteId,
      quotePayloadHash: sharedQuotePayloadHash,
    });

    // Verify both records reference the shared quoteId
    expect(consent1.quoteId).toBe(sharedQuoteId);
    expect(consent2.quoteId).toBe(sharedQuoteId);
    expect(consent1.id).not.toBe(consent2.id);

    // Collection query retrieves both in chronological order
    const consents = await consentRepo.findCheckoutConsentsByQuoteId(sharedQuoteId);
    expect(consents).toHaveLength(2);
    expect(consents[0]?.id).toBe(consent1.id);
    expect(consents[1]?.id).toBe(consent2.id);

    // Scoped query retrieves the exact record for a given adjustment
    const scoped1 = await consentRepo.findCheckoutConsentByAdjustmentAndQuoteId(adj1.id, sharedQuoteId);
    expect(scoped1?.id).toBe(consent1.id);
    expect(scoped1?.initialEstimatedTotal.toString()).toBe('3750');

    const scoped2 = await consentRepo.findCheckoutConsentByAdjustmentAndQuoteId(adj2.id, sharedQuoteId);
    expect(scoped2?.id).toBe(consent2.id);
    expect(scoped2?.initialEstimatedTotal.toString()).toBe('4500');
  });
});
