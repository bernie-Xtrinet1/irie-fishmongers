import {
  CustomerWeightApprovalStatus,
  FoodSafetyStatus,
  PreparationFeeStructure,
  Prisma,
  ProductUnit,
  SeafoodPricingBasis,
  UsablePartsPreference,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../../database/prisma.service';
import { CustomerWeightConsentRepository } from '../../repositories/customer-weight-consent.repository';
import {
  AmbiguousListingProvenanceError,
  ConflictingReplayError,
  InvalidPreparationOptionError,
  MissingAuthoritativeLotProvenanceError,
  MissingCheckoutConsentError,
  MissingListingProvenanceError,
  OrderItemNotFoundError,
  ProvenanceMismatchError,
  SeafoodSafetyHoldError,
  UnsupportedPreparationCurrencyError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../../repositories/seafood-order-weight-adjustment.repository';
import { computeCanonicalPayloadHash } from '../../repositories/utils/canonical-hash.util';
import { WeightAdjustmentSafetyGateService } from '../weight-adjustment-safety-gate.service';
import { WeightAdjustmentSnapshotInitializationService } from '../weight-adjustment-snapshot-initialization.service';

/**
 * Phase 16D WP3.2: Weight Adjustment Snapshot Initialization Service Unit Tests
 *
 * Covers all 15 required regression scenarios and operational requirements:
 * 1. Unknown selected preparation service is rejected (InvalidPreparationOptionError)
 * 2. Missing or malformed selected fee is rejected (InvalidPreparationOptionError)
 * 3. Unsupported currency is rejected (UnsupportedPreparationCurrencyError)
 * 4. Valid preparation service calculates the correct nonzero JMD fee
 * 5. Frozen inventory is not automatically rejected by 14-day rule (safety-gate spec)
 * 6. Future catch dates remain invalid (safety-gate spec)
 * 7. Normal replay rejects changed pricing or preparation terms (ConflictingReplayError)
 * 8. P2002 recovery rejects changed material terms (ConflictingReplayError)
 * 9. Missing checkout consent prevents successful replay (ConflictingReplayError)
 * 10. External transaction P2002 propagates
 * 11. Forged VerifiedOrderTimeEvidence is rejected (MissingAuthoritativeLotProvenanceError)
 * 12. Matching forged listing and lot IDs are rejected even when lot is SAFE (MissingAuthoritativeLotProvenanceError)
 * 13. Missing immutable checkout provenance blocks initialization (MissingAuthoritativeLotProvenanceError)
 * 14. LOT-A SAFETY_HOLD cannot be bypassed by presenting LOT-B SAFE (ProvenanceMismatchError / SeafoodSafetyHoldError)
 * 15. Order with simulated persisted provenance initializes when all checks pass
 */
describe('WeightAdjustmentSnapshotInitializationService', () => {
  let service: WeightAdjustmentSnapshotInitializationService;
  let prismaMock: any;
  let safetyGateMock: any;
  let adjustmentRepoMock: any;
  let consentRepoMock: any;

  const validOrderItemId = 'item-101';
  const validProductId = 'prod-snapper-1';
  const validVendorId = 'vendor-fishmonger-1';
  const validLotId = 'lot-a-original';
  const validListingId = 'listing-daily-1';
  const validCustomerId = 'cust-uuid-1';
  const orderTime = new Date('2026-10-21T10:00:00.000Z');

  // Standard OrderItem representing current Prisma schema (lacks originalLotId / originalListingId)
  const createMockOrderItem = (overrides: any = {}) => ({
    id: validOrderItemId,
    productId: validProductId,
    quantity: 2, // 2 pieces
    unit: ProductUnit.PER_POUND,
    unitPrice: new Prisma.Decimal('1500.00'), // 1500 JMD / lb
    createdAt: orderTime,
    product: {
      id: validProductId,
      inventoryMode: 'LISTING_BACKED',
      lotId: validLotId,
      weightLbs: new Prisma.Decimal('3.5'), // 3.5 lbs per fish -> total 7.0 lbs
      lot: { id: validLotId },
      catalogueItem: { id: 'cat-item-1', name: 'Red Snapper' },
    },
    vendorOrder: {
      id: 'vo-1',
      vendorId: validVendorId,
      order: {
        id: 'order-1',
        customerId: validCustomerId,
      },
      vendor: {
        id: validVendorId,
      },
    },
    weightAdjustment: null,
    ...overrides,
  });

  // Simulated OrderItem with persisted DB order-time provenance
  const createMockOrderItemWithProvenance = (overrides: any = {}) => ({
    ...createMockOrderItem(overrides),
    originalLotId: validLotId,
    originalListingId: validListingId,
    ...overrides,
  });

  const createMockListing = (overrides: any = {}) => ({
    id: validListingId,
    lotId: validLotId,
    vendorId: validVendorId,
    productId: validProductId,
    unit: ProductUnit.PER_POUND,
    price: new Prisma.Decimal('1500.00'),
    preparationOptions: [
      {
        id: 'scaled',
        label: 'Scaled & Gutted',
        fee: 500.0,
        currency: 'JMD',
      },
      {
        id: 'filleted',
        label: 'Skinless Fillet',
        fee: 750.0,
        currency: 'JMD',
      },
    ],
    expiresAt: new Date('2026-10-22T00:00:00.000Z'),
    createdAt: new Date('2026-10-21T06:00:00.000Z'), // created before order
    ...overrides,
  });

  const createMockConsent = (adjustmentId: string, overrides: any = {}) => {
    const base = {
      weightAdjustmentId: adjustmentId,
      authenticatedCustomerId: validCustomerId,
      initialEstimatedWeight: '7.000',
      initialEstimatedTotal: '11000.00',
      authorizedCeilingJmd: '12500.00',
      termsVersion: 'terms-2026-v2',
      ...overrides,
    };
    const payloadHash = computeCanonicalPayloadHash({
      weightAdjustmentId: base.weightAdjustmentId,
      authenticatedCustomerId: base.authenticatedCustomerId,
      initialEstimatedWeight: new Decimal(base.initialEstimatedWeight).toFixed(3),
      initialEstimatedTotal: new Decimal(base.initialEstimatedTotal).toFixed(2),
      authorizedCeilingJmd: new Decimal(base.authorizedCeilingJmd).toFixed(2),
      termsVersion: base.termsVersion,
    });
    return {
      id: 'consent-1',
      ...base,
      initialEstimatedWeight: new Prisma.Decimal(base.initialEstimatedWeight),
      initialEstimatedTotal: new Prisma.Decimal(base.initialEstimatedTotal),
      authorizedCeilingJmd: new Prisma.Decimal(base.authorizedCeilingJmd),
      payloadHash,
      consentedAt: new Date(),
      ...overrides,
    };
  };

  const createMockExistingAdjustment = (overrides: any = {}) => {
    const adjustmentId = 'adj-snap-1';
    const consent = overrides.checkoutCeilingConsent === null
      ? null
      : createMockConsent(adjustmentId, overrides.consentOverrides);
    return {
      id: adjustmentId,
      orderItemId: validOrderItemId,
      pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
      unit: WeightUnit.POUNDS,
      unitPrice: new Prisma.Decimal('1500.00'),
      pieceCount: 2,
      estimatedBillableWeight: new Prisma.Decimal('7.000'),
      preparationServiceName: 'Scaled & Gutted',
      usablePartsPreference: UsablePartsPreference.RETURN_USABLE_PARTS,
      preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
      preparationFeeRate: new Prisma.Decimal('500.00'),
      estimatedPreparationFee: new Prisma.Decimal('500.00'),
      estimatedProductSubtotal: new Prisma.Decimal('10500.00'),
      estimatedItemTotal: new Prisma.Decimal('11000.00'),
      customerAuthorizedCeilingJmd: new Prisma.Decimal('12500.00'),
      checkoutCeilingConsent: consent,
      ...overrides,
    };
  };

  beforeEach(() => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      orderItem: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockOrderItemWithProvenance())),
      },
      vendorDailyListing: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockListing())),
        findMany: jest.fn().mockImplementation(() => Promise.resolve([createMockListing()])),
      },
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    safetyGateMock = {
      assertLotSafeForFulfillment: jest.fn().mockResolvedValue({
        eligible: true,
        evaluatedAt: new Date(),
        blockingReasons: [],
        warnings: [],
      }),
    };

    adjustmentRepoMock = {
      createAdjustmentSnapshot: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          id: 'adj-snap-1',
          orderItemId: input.orderItemId,
          measurementStatus: WeightMeasurementStatus.PENDING_MEASUREMENT,
          customerApprovalStatus: CustomerWeightApprovalStatus.NOT_REQUIRED,
          activeMeasurementRevision: 0,
          customerAuthorizedCeilingJmd: input.customerAuthorizedCeilingJmd,
          estimatedItemTotal: input.estimatedItemTotal,
          estimatedPreparationFee: input.estimatedPreparationFee,
          estimatedProductSubtotal: input.estimatedProductSubtotal,
          estimatedBillableWeight: input.estimatedBillableWeight,
          unitPrice: input.unitPrice,
          unit: input.unit,
          pricingBasis: input.pricingBasis,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
      findByOrderItemId: jest.fn().mockResolvedValue(null),
    };

    consentRepoMock = {
      recordCheckoutCeilingConsent: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          id: 'consent-1',
          weightAdjustmentId: input.weightAdjustmentId,
          authenticatedCustomerId: input.authenticatedCustomerId,
          authorizedCeilingJmd: input.authorizedCeilingJmd,
          initialEstimatedTotal: input.initialEstimatedTotal,
          initialEstimatedWeight: input.initialEstimatedWeight,
          termsVersion: input.termsVersion,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          consentedAt: new Date(),
        }),
      ),
    };

    service = new WeightAdjustmentSnapshotInitializationService(
      prismaMock as unknown as PrismaService,
      safetyGateMock as unknown as WeightAdjustmentSafetyGateService,
      adjustmentRepoMock as unknown as SeafoodOrderWeightAdjustmentRepository,
      consentRepoMock as unknown as CustomerWeightConsentRepository,
    );
  });

  describe('Legacy product isolation', () => {
    it('returns SKIPPED_LEGACY_PRODUCT without creating snapshot or consent records', async () => {
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItem({
          product: {
            id: 'legacy-prod-1',
            inventoryMode: 'LEGACY_PRODUCT',
            lotId: null,
            weightLbs: null,
          },
        }),
      );

      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        customerAuthorizedCeilingJmd: '12000.00',
        termsVersion: 'v1.0',
      });

      expect(result.status).toBe('SKIPPED_LEGACY_PRODUCT');
      expect(result.weightAdjustment).toBeUndefined();
      expect(result.checkoutConsent).toBeUndefined();
      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
      expect(consentRepoMock.recordCheckoutCeilingConsent).not.toHaveBeenCalled();
    });
  });

  describe('Order Item lookup failure', () => {
    it('throws OrderItemNotFoundError when order item does not exist', async () => {
      prismaMock.orderItem.findUnique.mockResolvedValue(null);

      await expect(
        service.initializeSnapshot({
          orderItemId: 'nonexistent-item',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(OrderItemNotFoundError);
    });
  });

  describe('Scenario 1, 2, 3 & 4: Preparation fee handling against PreparationOptionDto[]', () => {
    it('Scenario 1: rejects unknown selected preparation service using InvalidPreparationOptionError', async () => {
      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Deep Fried and Seasoned', // not in listing options
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(InvalidPreparationOptionError);

      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });

    it('Scenario 2a: rejects preparation option with missing/null fee using InvalidPreparationOptionError', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue(
        createMockListing({
          preparationOptions: [
            { id: 'gutted', label: 'Gutted Only', fee: null, currency: 'JMD' },
          ],
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Gutted Only',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(InvalidPreparationOptionError);
    });

    it('Scenario 2b: rejects preparation option with negative fee using InvalidPreparationOptionError', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue(
        createMockListing({
          preparationOptions: [
            { id: 'gutted', label: 'Gutted Only', fee: -150.0, currency: 'JMD' },
          ],
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'gutted',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(InvalidPreparationOptionError);
    });

    it('Scenario 3: rejects preparation option with unsupported non-JMD currency using UnsupportedPreparationCurrencyError', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue(
        createMockListing({
          preparationOptions: [
            { id: 'filleted', label: 'Filleted', fee: 10.0, currency: 'USD' },
          ],
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'filleted',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(UnsupportedPreparationCurrencyError);
    });

    it('Scenario 4a: correctly parses valid preparation option and applies nonzero JMD fee', async () => {
      // 7 lbs @ 1500 = 10,500 JMD subtotal + 750 flat prep fee = 11,250 JMD total
      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        selectedPreparationServiceName: 'filleted',
        customerAuthorizedCeilingJmd: '13000.00',
        termsVersion: 'terms-2026-v2',
      });

      expect(result.status).toBe('INITIALIZED');
      expect(adjustmentRepoMock.createAdjustmentSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedPreparationFee: new Decimal('750'),
          estimatedProductSubtotal: new Decimal('10500'),
          estimatedItemTotal: new Decimal('11250'),
          preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
          preparationFeeRate: new Decimal('750'),
        }),
        expect.anything(),
      );
    });

    it('Scenario 4b: absent preparation service legitimately produces zero preparation fee', async () => {
      // 7 lbs @ 1500 = 10,500 JMD subtotal + 0 prep fee = 10,500 JMD total
      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        customerAuthorizedCeilingJmd: '12000.00',
        termsVersion: 'terms-2026-v2',
      });

      expect(result.status).toBe('INITIALIZED');
      expect(adjustmentRepoMock.createAdjustmentSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          estimatedPreparationFee: new Decimal('0'),
          estimatedProductSubtotal: new Decimal('10500'),
          estimatedItemTotal: new Decimal('10500'),
          preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
          preparationFeeRate: new Decimal('0'),
        }),
        expect.anything(),
      );
    });
  });

  describe('Scenario 7, 8 & 9: Complete replay and concurrency verification', () => {
    it('Scenario 7a: normal replay returns IDEMPOTENT_REPLAY when all terms match', async () => {
      const existing = createMockExistingAdjustment();
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          weightAdjustment: existing,
        }),
      );

      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        selectedPreparationServiceName: 'Scaled & Gutted',
        customerAuthorizedCeilingJmd: '12500.00',
        termsVersion: 'terms-2026-v2',
      });

      expect(result.status).toBe('IDEMPOTENT_REPLAY');
      expect(result.weightAdjustment).toEqual(existing);
      expect(result.checkoutConsent).toEqual(existing.checkoutCeilingConsent);
      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });

    it('Scenario 7b: normal replay rejects changed customer ceiling with ConflictingReplayError', async () => {
      const existing = createMockExistingAdjustment();
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          weightAdjustment: existing,
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Scaled & Gutted',
          customerAuthorizedCeilingJmd: '15000.00', // changed ceiling
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });

    it('Scenario 7c: normal replay rejects changed preparation service with ConflictingReplayError', async () => {
      const existing = createMockExistingAdjustment();
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          weightAdjustment: existing,
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Skinless Fillet', // changed service
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });

    it('Scenario 7d: normal replay rejects changed terms version with ConflictingReplayError', async () => {
      const existing = createMockExistingAdjustment();
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          weightAdjustment: existing,
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Scaled & Gutted',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v3-mutated', // changed version
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });

    it('Scenario 8: P2002 recovery validates all material terms and rejects conflicting ceiling', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`orderItemId`)',
        { code: 'P2002', clientVersion: '5.20.0' },
      );

      prismaMock.$transaction.mockRejectedValueOnce(p2002Error);

      const existingAfterRace = createMockExistingAdjustment();
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(existingAfterRace);

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Scaled & Gutted',
          customerAuthorizedCeilingJmd: '14000.00', // conflicts with persisted 12500.00
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });

    it('Scenario 8b: P2002 recovery returns IDEMPOTENT_REPLAY when all material terms match', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`orderItemId`)',
        { code: 'P2002', clientVersion: '5.20.0' },
      );

      prismaMock.$transaction.mockRejectedValueOnce(p2002Error);

      const existingAfterRace = createMockExistingAdjustment();
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(existingAfterRace);

      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        selectedPreparationServiceName: 'Scaled & Gutted',
        customerAuthorizedCeilingJmd: '12500.00',
        termsVersion: 'terms-2026-v2',
      });

      expect(result.status).toBe('IDEMPOTENT_REPLAY');
      expect(result.weightAdjustment).toEqual(existingAfterRace);
      expect(result.checkoutConsent).toEqual(existingAfterRace.checkoutCeilingConsent);
    });

    it('Scenario 9a: missing checkout consent on existing adjustment prevents successful replay (normal replay)', async () => {
      const existingWithoutConsent = createMockExistingAdjustment({
        checkoutCeilingConsent: null,
      });

      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          weightAdjustment: existingWithoutConsent,
        }),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });

    it('Scenario 9b: missing checkout consent on P2002 recovery prevents successful replay', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`orderItemId`)',
        { code: 'P2002', clientVersion: '5.20.0' },
      );

      prismaMock.$transaction.mockRejectedValueOnce(p2002Error);

      const existingWithoutConsent = createMockExistingAdjustment({
        checkoutCeilingConsent: null,
      });
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(existingWithoutConsent);

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ConflictingReplayError);
    });
  });

  describe('Scenario 10: External transaction P2002 propagation', () => {
    it('propagates P2002 error from external transaction without attempting internal recovery', async () => {
      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`orderItemId`)',
        { code: 'P2002', clientVersion: '5.20.0' },
      );

      const callerTx: any = {
        orderItem: {
          findUnique: jest.fn().mockRejectedValue(p2002Error),
        },
      };

      await expect(
        service.initializeSnapshot(
          {
            orderItemId: validOrderItemId,
            customerAuthorizedCeilingJmd: '12500.00',
            termsVersion: 'terms-2026-v2',
          },
          callerTx,
        ),
      ).rejects.toThrow(p2002Error);

      // Must not query top-level prisma for recovery when caller provided tx
      expect(prismaMock.seafoodOrderWeightAdjustment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 11, 12 & 13: Elimination of caller-forged provenance and enforcement of persisted checkout evidence', () => {
    it('Scenario 11: rejects forged VerifiedOrderTimeEvidence when orderItem lacks persisted DB provenance', async () => {
      // Standard orderItem lacking persisted originalLotId / originalListingId
      prismaMock.orderItem.findUnique.mockResolvedValue(createMockOrderItem());

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          verifiedOrderTimeEvidence: {
            lotId: 'forged-lot-id',
            listingId: 'forged-listing-id',
          },
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(MissingAuthoritativeLotProvenanceError);

      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });

    it('Scenario 12: rejects matching forged listing and lot IDs even when the lot is SAFE', async () => {
      prismaMock.orderItem.findUnique.mockResolvedValue(createMockOrderItem());

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          verifiedOrderTimeEvidence: {
            lotId: validLotId, // Matching SAFE lot
            listingId: validListingId, // Matching listing
          },
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(MissingAuthoritativeLotProvenanceError);

      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });

    it('Scenario 13: blocks initialization with MissingAuthoritativeLotProvenanceError when DB checkout provenance is missing', async () => {
      prismaMock.orderItem.findUnique.mockResolvedValue(createMockOrderItem());

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(MissingAuthoritativeLotProvenanceError);

      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 14: LOT-A SAFETY_HOLD cannot be bypassed by presenting LOT-B SAFE', () => {
    it('Scenario 14a: rejects caller attempt to present alternative listing or evidence for LOT-A order', async () => {
      const lotAId = 'lot-a-contaminated';
      const lotBId = 'lot-b-clean';
      const listingBId = 'listing-b';

      // Persisted truth: Order was placed for LOT-A
      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          originalLotId: lotAId,
          originalListingId: validListingId,
          product: {
            id: validProductId,
            inventoryMode: 'LISTING_BACKED',
            lotId: lotAId,
            weightLbs: new Prisma.Decimal('3.5'),
          },
        }),
      );

      // Caller attempts to supply evidence pointing to clean LOT-B
      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          verifiedOrderTimeEvidence: {
            lotId: lotBId,
            listingId: listingBId,
          },
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(ProvenanceMismatchError);

      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
    });

    it('Scenario 14b: safety gate evaluates persisted LOT-A and aborts when LOT-A is on SAFETY_HOLD', async () => {
      const lotAId = 'lot-a-contaminated';

      prismaMock.orderItem.findUnique.mockResolvedValue(
        createMockOrderItemWithProvenance({
          originalLotId: lotAId,
          originalListingId: validListingId,
          product: {
            id: validProductId,
            inventoryMode: 'LISTING_BACKED',
            lotId: lotAId,
            weightLbs: new Prisma.Decimal('3.5'),
          },
        }),
      );

      prismaMock.vendorDailyListing.findUnique.mockResolvedValue(
        createMockListing({
          lotId: lotAId,
        }),
      );

      safetyGateMock.assertLotSafeForFulfillment.mockRejectedValue(
        new SeafoodSafetyHoldError(lotAId, FoodSafetyStatus.SAFETY_HOLD, 'Lot A is on mandatory safety hold'),
      );

      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(SeafoodSafetyHoldError);

      expect(safetyGateMock.assertLotSafeForFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({ seafoodLotId: lotAId }),
        expect.anything(),
      );
      expect(adjustmentRepoMock.createAdjustmentSnapshot).not.toHaveBeenCalled();
      expect(consentRepoMock.recordCheckoutCeilingConsent).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 15: Successful initialization when persisted checkout provenance exists and passes all gates', () => {
    it('successfully initializes snapshot and records consent when all checks pass', async () => {
      const result = await service.initializeSnapshot({
        orderItemId: validOrderItemId,
        selectedPreparationServiceName: 'Scaled & Gutted',
        customerAuthorizedCeilingJmd: '12500.00',
        termsVersion: 'terms-2026-v2',
        ipAddress: '192.168.1.1',
        userAgent: 'JestTestBrowser/1.0',
      });

      expect(result.status).toBe('INITIALIZED');
      expect(result.weightAdjustment).toBeDefined();
      expect(result.checkoutConsent).toBeDefined();
      expect(safetyGateMock.assertLotSafeForFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
          vendorDailyListingId: validListingId,
        }),
        expect.anything(),
      );
      expect(adjustmentRepoMock.createAdjustmentSnapshot).toHaveBeenCalled();
      expect(consentRepoMock.recordCheckoutCeilingConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          authenticatedCustomerId: validCustomerId,
          termsVersion: 'terms-2026-v2',
          ipAddress: '192.168.1.1',
          userAgent: 'JestTestBrowser/1.0',
        }),
        expect.anything(),
      );
    });
  });

  describe('Customer checkout ceiling validation (zero tolerance synthesis)', () => {
    it('fails closed when customer ceiling is omitted', async () => {
      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(MissingCheckoutConsentError);
    });

    it('fails closed when ceiling is lower than estimated total', async () => {
      // 7 lbs * 1500 = 10,500 + 500 flat prep = 11,000 JMD
      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Scaled & Gutted',
          customerAuthorizedCeilingJmd: '10000.00', // lower than 11,000 JMD
          termsVersion: 'terms-2026-v2',
        }),
      ).rejects.toThrow(MissingCheckoutConsentError);
    });

    it('fails closed when termsVersion is empty or whitespace', async () => {
      await expect(
        service.initializeSnapshot({
          orderItemId: validOrderItemId,
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: '   ',
        }),
      ).rejects.toThrow(MissingCheckoutConsentError);
    });
  });

  describe('Caller-supplied transaction propagation', () => {
    it('executes in caller transaction client without opening new transaction', async () => {
      const callerTx: any = {
        orderItem: {
          findUnique: jest.fn().mockResolvedValue(createMockOrderItemWithProvenance()),
        },
        vendorDailyListing: {
          findUnique: jest.fn().mockResolvedValue(createMockListing()),
        },
      };

      const result = await service.initializeSnapshot(
        {
          orderItemId: validOrderItemId,
          selectedPreparationServiceName: 'Scaled & Gutted',
          customerAuthorizedCeilingJmd: '12500.00',
          termsVersion: 'terms-2026-v2',
        },
        callerTx,
      );

      expect(result.status).toBe('INITIALIZED');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(callerTx.orderItem.findUnique).toHaveBeenCalled();
    });
  });
});
