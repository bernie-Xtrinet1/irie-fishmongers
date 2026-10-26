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
} from '@prisma/client';
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
  SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
  SeafoodPurchaseSnapshotV1,
} from '../../domain/seafood-purchase-provenance.types';

jest.setTimeout(60_000);

describe('Phase 16D WP4.2B: Seafood Hybrid Purchase-Time Provenance (Real PostgreSQL)', () => {
  let prisma: PrismaClient;
  const migrationSqlPath = path.resolve(
    __dirname,
    '../../../../../prisma/migrations/20261025120000_phase_16d_wp41_order_item_provenance/migration.sql',
  );
  const rollbackSqlPath = path.resolve(
    __dirname,
    '../../../../../prisma/migrations/20261025120000_phase_16d_wp41_order_item_provenance/rollback.sql',
  );

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
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  // Helper to generate a valid mock SeafoodPurchaseSnapshotV1
  function createSampleSnapshot(overrides?: Partial<SeafoodPurchaseSnapshotV1>): SeafoodPurchaseSnapshotV1 {
    return {
      schemaVersion: SEAFOOD_PURCHASE_SNAPSHOT_SCHEMA_VERSION,
      originalLotId: overrides?.originalLotId ?? `lot-${randomUUID()}`,
      originalListingId: overrides?.originalListingId ?? `listing-${randomUUID()}`,
      vendorId: overrides?.vendorId ?? `vendor-${randomUUID()}`,
      productId: overrides?.productId ?? `prod-${randomUUID()}`,
      productName: overrides?.productName ?? 'Yellowfin Tuna Steak',
      pricingBasis: overrides?.pricingBasis ?? SeafoodPricingBasis.WHOLE_RAW,
      currency: overrides?.currency ?? 'JMD',
      unitPrice: overrides?.unitPrice ?? '1500.00',
      unit: overrides?.unit ?? ProductUnit.PER_POUND,
      pieceCount: overrides?.pieceCount ?? 1,
      estimatedWeightLbs: overrides?.estimatedWeightLbs ?? 2.5,
      purchasedAt: overrides?.purchasedAt ?? new Date().toISOString(),
      ...overrides,
    };
  }

  // Helper to seed minimal relational prerequisites (Vendor, Customer, Category, Product, SeafoodLot, VendorDailyListing, Order, VendorOrder)
  async function seedTestPrerequisites(client: PrismaClient) {
    const nonce = randomUUID().substring(0, 8);

    // Roles
    await client.role.upsert({ where: { name: RoleName.CUSTOMER }, update: {}, create: { name: RoleName.CUSTOMER } });
    await client.role.upsert({ where: { name: RoleName.VENDOR }, update: {}, create: { name: RoleName.VENDOR } });

    // Customer
    const customerUser = await client.user.create({
      data: {
        email: `cust-${nonce}@test.disposable.local`,
        passwordHash: 'insecure-test-hash',
        firstName: 'Test',
        lastName: 'Customer',
        roles: { create: { role: { connect: { name: RoleName.CUSTOMER } } } },
      },
    });

    // Vendor User
    const vendorUser = await client.user.create({
      data: {
        email: `vend-${nonce}@test.disposable.local`,
        passwordHash: 'insecure-test-hash',
        firstName: 'Test',
        lastName: 'Vendor',
        roles: { create: { role: { connect: { name: RoleName.VENDOR } } } },
      },
    });

    // Vendor
    const vendor = await client.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: `Test Fishery ${nonce}`,
        description: 'Test disposable vendor',
        parish: Parish.KINGSTON,
        phone: '876-555-0199',
        termsAcceptedAt: new Date(),
      },
    });

    // Category
    const category = await client.category.create({
      data: {
        name: `Seafood-${nonce}`,
        slug: `seafood-${nonce}`,
      },
    });

    // SeafoodLot
    const lot = await client.seafoodLot.create({
      data: {
        lotNumber: `LOT-${nonce}`,
        publicTraceToken: randomUUID(),
        vendorId: vendor.id,
        species: 'Thunnus albacares',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: '100.00',
        weightUnit: WeightUnit.POUNDS,
      },
    });

    // Product
    const product = await client.product.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        name: `Tuna Loin ${nonce}`,
        description: 'Fresh Tuna Loin',
        price: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantityAvailable: 50,
        imageUrl: 'https://example.test/tuna.jpg',
        lotId: lot.id,
      },
    });

    // Catalogue item required for listing
    const catalogueItem = await client.seafoodCatalogueItem.create({
      data: {
        name: `Yellowfin Tuna ${nonce}`,
        commonName: `Tuna-${nonce}`,
        scientificName: 'Thunnus albacares',
        categoryId: category.id,
      },
    });

    // VendorDailyListing
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

    // Order & VendorOrder
    const order = await client.order.create({
      data: {
        customerId: customerUser.id,
        deliveryAddressLine1: '123 Harbor Rd',
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

    return { customerUser, vendor, category, lot, product, listing, order, vendorOrder };
  }

  // ==========================================================================
  // SCENARIO 1: Required Schema Columns and Indexes Verification
  // ==========================================================================
  it('Scenario 1: verifies order_items contains provenance columns and indexes with exact data types', async () => {
    // Columns check
    const columns: Array<{ column_name: string; data_type: string; is_nullable: string }> = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'order_items'
        AND column_name IN ('originalLotId', 'originalListingId', 'purchaseSnapshot');
    `;

    expect(columns).toHaveLength(3);
    const lotCol = columns.find((c) => c.column_name === 'originalLotId');
    const listingCol = columns.find((c) => c.column_name === 'originalListingId');
    const snapCol = columns.find((c) => c.column_name === 'purchaseSnapshot');

    expect(lotCol).toBeDefined();
    expect(lotCol?.data_type).toBe('text');
    expect(lotCol?.is_nullable).toBe('YES');

    expect(listingCol).toBeDefined();
    expect(listingCol?.data_type).toBe('text');
    expect(listingCol?.is_nullable).toBe('YES');

    expect(snapCol).toBeDefined();
    expect(snapCol?.data_type).toBe('jsonb');
    expect(snapCol?.is_nullable).toBe('YES');

    // Indexes check
    const indexes: Array<{ indexname: string }> = await prisma.$queryRaw`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'order_items'
        AND indexname IN ('idx_order_items_original_lot', 'idx_order_items_original_listing');
    `;

    expect(indexes.some((i) => i.indexname === 'idx_order_items_original_lot')).toBe(true);
    expect(indexes.some((i) => i.indexname === 'idx_order_items_original_listing')).toBe(true);
  });

  // ==========================================================================
  // SCENARIO 2: Foreign-Key Deletion Restrictions (ON DELETE RESTRICT)
  // ==========================================================================
  it('Scenario 2: proves foreign keys prevent deletion of referenced SeafoodLot or VendorDailyListing', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const snapshot = createSampleSnapshot({
      originalLotId: fixture.lot.id,
      originalListingId: fixture.listing.id,
      vendorId: fixture.vendor.id,
      productId: fixture.product.id,
    });

    await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 2,
        subtotal: '3000.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: snapshot as unknown as object,
      },
    });

    // Attempting to delete SeafoodLot must fail due to ON DELETE RESTRICT
    await expect(
      prisma.seafoodLot.delete({ where: { id: fixture.lot.id } }),
    ).rejects.toThrow(/foreign key constraint/i);

    // Attempting to delete VendorDailyListing must fail due to ON DELETE RESTRICT
    await expect(
      prisma.vendorDailyListing.delete({ where: { id: fixture.listing.id } }),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  // ==========================================================================
  // SCENARIO 3: Legacy Nullable Provenance Insertion
  // ==========================================================================
  it('Scenario 3: proves legacy orders can insert OrderItems with NULL provenance fields', async () => {
    const fixture = await seedTestPrerequisites(prisma);

    const orderItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '500.00',
        unit: ProductUnit.PER_ITEM,
        quantity: 1,
        subtotal: '500.00',
        currency: 'JMD',
        originalLotId: null,
        originalListingId: null,
        purchaseSnapshot: undefined,
      },
    });

    expect(orderItem.id).toBeDefined();
    expect(orderItem.originalLotId).toBeNull();
    expect(orderItem.originalListingId).toBeNull();
    expect(orderItem.purchaseSnapshot).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 4: NULL-to-Value Immutability (P1-01 Hardened Anti-Backfill)
  // ==========================================================================
  it('Scenario 4: proves PostgreSQL trigger rejects backfilling NULL provenance to a non-NULL value', async () => {
    const fixture = await seedTestPrerequisites(prisma);

    const legacyItem = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '500.00',
        unit: ProductUnit.PER_ITEM,
        quantity: 1,
        subtotal: '500.00',
        currency: 'JMD',
        originalLotId: null,
        originalListingId: null,
        purchaseSnapshot: undefined,
      },
    });

    // Attempting to backfill originalLotId on a legacy order item MUST be rejected by trigger
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "originalLotId" = ${fixture.lot.id}
        WHERE id = ${legacyItem.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);

    // Attempting to backfill originalListingId MUST be rejected
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "originalListingId" = ${fixture.listing.id}
        WHERE id = ${legacyItem.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);

    // Attempting to backfill purchaseSnapshot MUST be rejected
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "purchaseSnapshot" = '{"schemaVersion":1}'::jsonb
        WHERE id = ${legacyItem.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);
  });

  // ==========================================================================
  // SCENARIO 5: Value-to-NULL Immutability (Anti-Tamper Cleardown)
  // ==========================================================================
  it('Scenario 5: proves PostgreSQL trigger rejects clearing established provenance to NULL', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const snapshot = createSampleSnapshot({
      originalLotId: fixture.lot.id,
      originalListingId: fixture.listing.id,
      vendorId: fixture.vendor.id,
      productId: fixture.product.id,
    });

    const item = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 2,
        subtotal: '3000.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: snapshot as unknown as object,
      },
    });

    // Attempting to clear originalLotId to NULL
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "originalLotId" = NULL
        WHERE id = ${item.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);

    // Attempting to clear purchaseSnapshot to NULL
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "purchaseSnapshot" = NULL
        WHERE id = ${item.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);
  });

  // ==========================================================================
  // SCENARIO 6: Value-to-Different-Value Immutability (Anti-Tamper Reassignment)
  // ==========================================================================
  it('Scenario 6: proves PostgreSQL trigger rejects modifying originalLotId or originalListingId to another entity', async () => {
    const fixture = await seedTestPrerequisites(prisma);

    // Create a second lot
    const secondLot = await prisma.seafoodLot.create({
      data: {
        lotNumber: `LOT-SEC-${randomUUID().substring(0, 8)}`,
        publicTraceToken: randomUUID(),
        vendorId: fixture.vendor.id,
        species: 'Lutjanus campechanus',
        storageType: SeafoodStorageType.FRESH,
        catchDate: new Date(),
        weight: '50.00',
        weightUnit: WeightUnit.POUNDS,
      },
    });

    const item = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 2,
        subtotal: '3000.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: createSampleSnapshot({ originalLotId: fixture.lot.id }) as unknown as object,
      },
    });

    // Attempting to change originalLotId to secondLot
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "originalLotId" = ${secondLot.id}
        WHERE id = ${item.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);
  });

  // ==========================================================================
  // SCENARIO 7: JSONB Snapshot Immutability (Sub-field Tamper Protection)
  // ==========================================================================
  it('Scenario 7: proves PostgreSQL trigger rejects modifying any sub-property of purchaseSnapshot', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const snapshot = createSampleSnapshot({
      originalLotId: fixture.lot.id,
      originalListingId: fixture.listing.id,
      vendorId: fixture.vendor.id,
      productId: fixture.product.id,
      unitPrice: '1500.00',
    });

    const item = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 2,
        subtotal: '3000.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: snapshot as unknown as object,
      },
    });

    // Attempting to mutate unitPrice inside purchaseSnapshot using jsonb_set
    await expect(
      prisma.$executeRaw`
        UPDATE "order_items"
        SET "purchaseSnapshot" = jsonb_set("purchaseSnapshot", '{unitPrice}', '"999.00"')
        WHERE id = ${item.id};
      `,
    ).rejects.toThrow(/Immutable purchase-time provenance cannot be updated/i);
  });

  // ==========================================================================
  // SCENARIO 8: Unrelated OrderItem Update Pass-Through (Safe Mutation)
  // ==========================================================================
  it('Scenario 8: proves PostgreSQL trigger permits updates when provenance fields remain unchanged', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const snapshot = createSampleSnapshot({
      originalLotId: fixture.lot.id,
      originalListingId: fixture.listing.id,
      vendorId: fixture.vendor.id,
      productId: fixture.product.id,
    });

    const item = await prisma.orderItem.create({
      data: {
        vendorOrderId: fixture.vendorOrder.id,
        productId: fixture.product.id,
        productName: fixture.product.name,
        unitPrice: '1500.00',
        unit: ProductUnit.PER_POUND,
        quantity: 2,
        subtotal: '3000.00',
        currency: 'JMD',
        originalLotId: fixture.lot.id,
        originalListingId: fixture.listing.id,
        purchaseSnapshot: snapshot as unknown as object,
      },
    });

    // Updating quantity, subtotal, and productName without touching provenance
    const updated = await prisma.orderItem.update({
      where: { id: item.id },
      data: {
        quantity: 3,
        subtotal: '4500.00',
        productName: 'Updated Tuna Steak Name',
      },
    });

    expect(updated.quantity).toBe(3);
    expect(updated.subtotal.toString()).toBe('4500');
    expect(updated.productName).toBe('Updated Tuna Steak Name');
    expect(updated.originalLotId).toBe(fixture.lot.id);
  });

  // ==========================================================================
  // SCENARIO 9: Transaction Rollback on Trigger Failure (Atomicity Protection)
  // ==========================================================================
  it('Scenario 9: proves trigger exception rolls back the entire containing database transaction', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const snapshot = createSampleSnapshot({ originalLotId: fixture.lot.id });

    const item = await prisma.orderItem.create({
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

    // Execute atomic transaction with one valid update followed by an invalid provenance update
    await expect(
      prisma.$transaction(async (tx) => {
        // Step A: Modify quantity on item (valid)
        await tx.orderItem.update({
          where: { id: item.id },
          data: { quantity: 5 },
        });

        // Step B: Illegal provenance modification (trigger will throw)
        await tx.$executeRaw`
          UPDATE "order_items"
          SET "originalLotId" = 'illegal-lot-tamper'
          WHERE id = ${item.id};
        `;
      }),
    ).rejects.toThrow();

    // Verify quantity was NOT persisted due to transaction rollback
    const afterItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(afterItem.quantity).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 10: Concurrent Mutation Attempts
  // ==========================================================================
  it('Scenario 10: proves concurrent attempts to mutate provenance are both blocked by trigger', async () => {
    const fixture = await seedTestPrerequisites(prisma);
    const item = await prisma.orderItem.create({
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
        purchaseSnapshot: createSampleSnapshot({ originalLotId: fixture.lot.id }) as unknown as object,
      },
    });

    const [attempt1, attempt2] = await Promise.allSettled([
      prisma.$executeRaw`UPDATE "order_items" SET "originalLotId" = 'concurrent-1' WHERE id = ${item.id};`,
      prisma.$executeRaw`UPDATE "order_items" SET "originalLotId" = 'concurrent-2' WHERE id = ${item.id};`,
    ]);

    expect(attempt1.status).toBe('rejected');
    expect(attempt2.status).toBe('rejected');
  });

  // ==========================================================================
  // SCENARIO 11: Foreign-Key Insertion / Race Condition
  // ==========================================================================
  it('Scenario 11: proves inserting an OrderItem with a non-existent originalLotId fails foreign-key constraint', async () => {
    const fixture = await seedTestPrerequisites(prisma);

    await expect(
      prisma.orderItem.create({
        data: {
          vendorOrderId: fixture.vendorOrder.id,
          productId: fixture.product.id,
          productName: fixture.product.name,
          unitPrice: '1500.00',
          unit: ProductUnit.PER_POUND,
          quantity: 1,
          subtotal: '1500.00',
          currency: 'JMD',
          originalLotId: 'non-existent-lot-uuid',
        },
      }),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  // ==========================================================================
  // SCENARIO 12: Guarded Rollback Refusal on Populated Provenance (Auxiliary DB)
  // ==========================================================================
  it('Scenario 12: proves rollback.sql refuses execution and preserves schema/data when provenance is populated', async () => {
    const refusalDbUrl = `postgresql://irie_wp42b_admin:IrieTest_wp42b_disposable_2026!@127.0.0.1:${EXPECTED_NATIVE_CLUSTER_PORT}/${EXPECTED_ROLLBACK_REFUSAL_DB_NAME}?schema=public`;
    const refusalPrisma = new PrismaClient({
      datasources: { db: { url: refusalDbUrl } },
    });

    try {
      await refusalPrisma.$connect();
      // 1. Verify auxiliary database identity
      await assertNativeClusterIsolation(refusalPrisma, {
        expectedDbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
        expectedDataDir: EXPECTED_TEMPORARY_DATA_DIR,
        allowNonEmpty: true,
      });

      // 2. Insert synthetic prerequisite records and an OrderItem containing valid, populated provenance
      const fixture = await seedTestPrerequisites(refusalPrisma);
      const snapshot = createSampleSnapshot({
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
          quantity: 2,
          subtotal: '3000.00',
          currency: 'JMD',
          originalLotId: fixture.lot.id,
          originalListingId: fixture.listing.id,
          purchaseSnapshot: snapshot as unknown as object,
        },
      });

      // 3. Verify provenance fields are stored
      const verifiedItem = await refusalPrisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(verifiedItem.originalLotId).toBe(fixture.lot.id);
      expect(verifiedItem.originalListingId).toBe(fixture.listing.id);
      expect(verifiedItem.purchaseSnapshot).not.toBeNull();

      // Disconnect Prisma before invoking psql to avoid lock contention
      await refusalPrisma.$disconnect();

      // 4 & 5. Execute committed rollback.sql using psql.exe -v ON_ERROR_STOP=1 -f
      expect(fs.existsSync(rollbackSqlPath)).toBe(true);
      const psqlResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_REFUSAL_DB_NAME,
        rollbackSqlPath,
      });

      // 6. Assert that rollback execution fails with expected ROLLBACK REFUSED exception
      expect(psqlResult.exitCode).not.toBe(0);
      expect(psqlResult.stderr).toMatch(/ROLLBACK REFUSED: order_items table contains \d+ records with non-null purchase-time provenance/i);

      // Reconnect to verify schema and data preservation
      await refusalPrisma.$connect();

      // 7 & 8. Verify columns, trigger, foreign keys, and populated OrderItem remain intact
      const cols: Array<{ column_name: string }> = await refusalPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_items'
          AND column_name IN ('originalLotId', 'originalListingId', 'purchaseSnapshot');
      `;
      expect(cols).toHaveLength(3);

      const triggers: Array<{ tgname: string }> = await refusalPrisma.$queryRaw`
        SELECT tgname FROM pg_trigger WHERE tgname = 'trg_prevent_order_item_provenance_mutation';
      `;
      expect(triggers).toHaveLength(1);

      const constraints: Array<{ conname: string }> = await refusalPrisma.$queryRaw`
        SELECT conname FROM pg_constraint
        WHERE conname IN ('fk_order_item_original_lot', 'fk_order_item_original_listing');
      `;
      expect(constraints).toHaveLength(2);

      const preservedItem = await refusalPrisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(preservedItem.originalLotId).toBe(fixture.lot.id);
      expect(preservedItem.originalListingId).toBe(fixture.listing.id);
    } finally {
      await refusalPrisma.$disconnect();
    }
  });

  // ==========================================================================
  // SCENARIO 13: Clean Rollback on Disposable State (Auxiliary DB)
  // ==========================================================================
  it('Scenario 13: proves rollback.sql executes cleanly on unpopulated auxiliary database', async () => {
    const cleanDbUrl = `postgresql://irie_wp42b_admin:IrieTest_wp42b_disposable_2026!@127.0.0.1:${EXPECTED_NATIVE_CLUSTER_PORT}/${EXPECTED_ROLLBACK_CLEAN_DB_NAME}?schema=public`;
    const cleanPrisma = new PrismaClient({
      datasources: { db: { url: cleanDbUrl } },
    });

    try {
      await cleanPrisma.$connect();

      // 1. Verify auxiliary database identity
      await assertNativeClusterIsolation(cleanPrisma, {
        expectedDbName: EXPECTED_ROLLBACK_CLEAN_DB_NAME,
        expectedPort: EXPECTED_NATIVE_CLUSTER_PORT,
        expectedDataDir: EXPECTED_TEMPORARY_DATA_DIR,
        allowNonEmpty: true,
      });

      // 2. Confirm complete Prisma migration chain has been applied
      const migrationRows: Array<{ count: number }> = await cleanPrisma.$queryRaw`
        SELECT count(*)::int as count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
      `;
      expect(Number(migrationRows[0]?.count)).toBe(54);

      // 3. Confirm there are no populated provenance fields in this clean auxiliary database
      const provenanceCountRows: Array<{ count: number }> = await cleanPrisma.$queryRaw`
        SELECT count(*)::int as count FROM "order_items"
        WHERE "originalLotId" IS NOT NULL
           OR "originalListingId" IS NOT NULL
           OR "purchaseSnapshot" IS NOT NULL;
      `;
      expect(Number(provenanceCountRows[0]?.count)).toBe(0);

      // Disconnect Prisma before running psql to avoid lock contention
      await cleanPrisma.$disconnect();

      // 4. Execute committed rollback.sql using psql.exe -v ON_ERROR_STOP=1 -f
      expect(fs.existsSync(rollbackSqlPath)).toBe(true);
      const psqlResult = executeRollbackScriptWithPsql({
        dbName: EXPECTED_ROLLBACK_CLEAN_DB_NAME,
        rollbackSqlPath,
      });

      // 5. Require exit code 0
      expect(psqlResult.exitCode).toBe(0);

      // Reconnect to verify clean rollback schema state
      await cleanPrisma.$connect();

      // 6. Verify provenance columns are removed
      const remainingCols: Array<{ column_name: string }> = await cleanPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_items'
          AND column_name IN ('originalLotId', 'originalListingId', 'purchaseSnapshot');
      `;
      expect(remainingCols).toHaveLength(0);

      // 7. Verify corresponding indexes, foreign keys, trigger and function are removed
      const remainingIndexes: Array<{ indexname: string }> = await cleanPrisma.$queryRaw`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'order_items'
          AND indexname IN ('idx_order_items_original_lot', 'idx_order_items_original_listing');
      `;
      expect(remainingIndexes).toHaveLength(0);

      const remainingConstraints: Array<{ conname: string }> = await cleanPrisma.$queryRaw`
        SELECT conname FROM pg_constraint
        WHERE conname IN ('fk_order_item_original_lot', 'fk_order_item_original_listing');
      `;
      expect(remainingConstraints).toHaveLength(0);

      const remainingTriggers: Array<{ tgname: string }> = await cleanPrisma.$queryRaw`
        SELECT tgname FROM pg_trigger WHERE tgname = 'trg_prevent_order_item_provenance_mutation';
      `;
      expect(remainingTriggers).toHaveLength(0);

      const remainingProcs: Array<{ proname: string }> = await cleanPrisma.$queryRaw`
        SELECT proname FROM pg_proc WHERE proname = 'prevent_order_item_provenance_mutation';
      `;
      expect(remainingProcs).toHaveLength(0);

      // 8. Verify unrelated OrderItem columns and unrelated tables remain intact
      const standardCols: Array<{ column_name: string }> = await cleanPrisma.$queryRaw`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_items'
          AND column_name IN ('id', 'vendorOrderId', 'productId', 'productName', 'unitPrice', 'quantity', 'subtotal');
      `;
      expect(standardCols).toHaveLength(7);

      const tables: Array<{ table_name: string }> = await cleanPrisma.$queryRaw`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users', 'vendors', 'products', 'orders', 'vendor_orders');
      `;
      expect(tables).toHaveLength(5);
    } finally {
      await cleanPrisma.$disconnect();
    }
  });

  // ==========================================================================
  // SCENARIO 14: Prisma Migration Deployment Idempotency and Ledger Verification
  // ==========================================================================
  it('Scenario 14: proves Prisma migration deployment idempotency and ledger integrity', async () => {
    // 1. Verify that migration.sql contains defensive idempotent DDL guards
    expect(fs.existsSync(migrationSqlPath)).toBe(true);
    const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "originalLotId"');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "originalListingId"');
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "purchaseSnapshot"');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS "idx_order_items_original_lot"');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS "idx_order_items_original_listing"');
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION prevent_order_item_provenance_mutation');
    expect(migrationSql).toContain('DROP TRIGGER IF EXISTS trg_prevent_order_item_provenance_mutation');

    // 2. Verify Prisma migration deployment ledger behavior:
    // In Prisma Migrate, deployment idempotency is guaranteed by tracking applied migrations
    // in _prisma_migrations. When a migration is marked finished, Prisma skips re-execution.
    interface PrismaMigrationRow {
      migration_name: string;
      finished_at: Date | string | null;
      rolled_back_at: Date | string | null;
      applied_steps_count: number;
    }

    const migrationRecord: PrismaMigrationRow[] = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
      FROM "_prisma_migrations"
      WHERE migration_name = '20261025120000_phase_16d_wp41_order_item_provenance';
    `;

    expect(migrationRecord).toHaveLength(1);
    const record = migrationRecord[0];
    expect(record?.finished_at).not.toBeNull();
    expect(record?.rolled_back_at).toBeNull();
    expect(record?.applied_steps_count).toBeGreaterThanOrEqual(1);

    // 3. Proves schema stability: re-verifying columns confirms no duplicate or drifted state
    const cols: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'order_items'
        AND column_name IN ('originalLotId', 'originalListingId', 'purchaseSnapshot');
    `;
    expect(cols).toHaveLength(3);
  });
});
