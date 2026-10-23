import {
  ApprovalChallengeStatus,
  CertificationStatus,
  CustomerWeightApprovalStatus,
  FishermanStatus,
  FoodSafetyStatus,
  PreparationFeeStructure,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodPricingBasis,
  UserStatus,
  VendorStatus,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { RequestUser } from '../../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  MissingAuthoritativeLotProvenanceError,
  ProvenanceMismatchError,
  SeafoodSafetyHoldError,
  StaleRevisionConflictError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../../repositories/seafood-order-weight-adjustment.repository';
import { SeafoodWeightMeasurementEventRepository } from '../../repositories/seafood-weight-measurement-event.repository';
import { SeafoodWeightMeasurementService } from '../seafood-weight-measurement.service';
import {
  InvalidScaleEvidenceError,
  MeasurementCorrectionProhibitedError,
  MissingCorrectionReasonError,
  PreparationCommencementIndeterminateError,
  UnauthorizedMeasurementOperatorError,
} from '../types/weight-measurement-fulfillment.types';
import { WeightAdjustmentSafetyGateService } from '../weight-adjustment-safety-gate.service';

/**
 * Phase 16D WP3.3: Authoritative Weight Measurement Service Unit & Security Tests
 */
describe('SeafoodWeightMeasurementService', () => {
  let service: SeafoodWeightMeasurementService;
  let prismaMock: any;
  let safetyGateMock: any;
  let adjustmentRepoMock: any;
  let measurementRepoMock: any;

  const validAdjustmentId = 'adj-101';
  const validOrderItemId = 'item-101';
  const validVendorId = 'vendor-fishmonger-1';
  const validVendorUserId = 'user-vendor-owner';
  const validOperatorUserId = validVendorUserId; // Default operator is the authorized vendor owner
  const validLotId = 'lot-a-snapper';
  const validPhotoUrl = 'https://s3.amazonaws.com/scale-photos/snap-101-rev-1.jpg';

  const validActor: RequestUser = {
    id: validVendorUserId,
    email: 'owner@vendor.com',
    roles: [RoleName.VENDOR],
  };

  const createMockUser = (overrides: any = {}) => ({
    id: validVendorUserId,
    status: UserStatus.ACTIVE,
    roles: [
      {
        role: {
          id: 'role-vendor-id',
          name: RoleName.VENDOR,
        },
      },
    ],
    fisherman: null,
    ...overrides,
  });

  const createMockFishermanCertification = (overrides: any = {}) => ({
    id: 'cert-nfa-1',
    fishermanId: 'fish-profile-owner',
    certificateType: 'NFA_COMMERCIAL_FISHER_LICENCE',
    certificateNumber: 'NFA-2026-0042',
    issuingAuthorityId: 'auth-nfa-1',
    issuedDate: new Date('2026-01-01'),
    expiryDate: new Date('2027-01-01'),
    status: CertificationStatus.ACTIVE,
    documentUrl: 'https://storage.example.com/certs/nfa-cert.pdf',
    issuingAuthority: {
      id: 'auth-nfa-1',
      name: 'Fisheries Division / National Fisheries Authority',
      country: 'Jamaica',
    },
    ...overrides,
  });

  const createMockFisherman = (overrides: any = {}) => ({
    id: 'fish-profile-owner',
    userId: validVendorUserId,
    status: FishermanStatus.APPROVED,
    fishingLicenseNumber: 'FL-JM-2026-8891',
    certifications: [createMockFishermanCertification()],
    ...overrides,
  });

  const createMockAdjustment = (overrides: any = {}) => ({
    id: validAdjustmentId,
    orderItemId: validOrderItemId,
    pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
    unit: WeightUnit.POUNDS,
    unitPrice: new Prisma.Decimal('1500.00'), // 1500 JMD / lb
    estimatedBillableWeight: new Prisma.Decimal('5.000'), // estimated 5 lbs -> 7500 JMD product
    preparationServiceName: 'Scaled & Gutted',
    preparationFeeStructure: PreparationFeeStructure.FLAT_FEE,
    preparationFeeRate: new Prisma.Decimal('500.00'), // 500 flat prep
    estimatedPreparationFee: new Prisma.Decimal('500.00'),
    estimatedProductSubtotal: new Prisma.Decimal('7500.00'),
    estimatedItemTotal: new Prisma.Decimal('8000.00'),
    customerAuthorizedCeilingJmd: new Prisma.Decimal('9500.00'), // Ceiling: 9500 JMD
    activeMeasurementRevision: null,
    activePreparationRevision: null,
    measurementStatus: WeightMeasurementStatus.PENDING_MEASUREMENT,
    customerApprovalStatus: CustomerWeightApprovalStatus.NOT_REQUIRED,
    boundApprovalRevision: null,
    orderItem: {
      id: validOrderItemId,
      originalLotId: validLotId,
      vendorOrder: {
        vendorId: validVendorId,
        vendor: {
          id: validVendorId,
          userId: validVendorUserId,
          status: VendorStatus.APPROVED,
        },
        order: {
          id: 'order-1',
          customerId: 'cust-1',
        },
      },
      product: {
        id: 'prod-snapper-1',
        lotId: validLotId,
        lot: { id: validLotId },
      },
    },
    ...overrides,
  });

  const createMockMeasurementEvent = (overrides: any = {}) => ({
    id: 'event-meas-1',
    weightAdjustmentId: validAdjustmentId,
    revision: 1,
    idempotencyKey: 'idemp-meas-1',
    payloadHash: 'hash-meas-1',
    pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
    unit: WeightUnit.POUNDS,
    measuredWeight: new Prisma.Decimal('5.500'),
    scalePhotoUrl: validPhotoUrl,
    scaleDeviceIdentifier: 'SCALE-DIGI-01',
    scaleCalibrationDate: new Date('2026-01-01'),
    operatorUserId: validOperatorUserId,
    correctionReason: null,
    recordedAt: new Date(),
    ...overrides,
  });

  const createValidInput = (overrides: any = {}) => ({
    weightAdjustmentId: validAdjustmentId,
    expectedRevision: 1,
    idempotencyKey: 'idemp-meas-1',
    measuredWeight: '5.500',
    scalePhotoUrl: validPhotoUrl,
    scaleDeviceIdentifier: 'SCALE-DIGI-01',
    operatorUserId: validOperatorUserId,
    authenticatedActor: validActor,
    tareIsolated: true,
    ...overrides,
  });

  beforeEach(() => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockAdjustment())),
        update: jest.fn().mockImplementation((args) =>
          Promise.resolve({
            ...createMockAdjustment(),
            ...args.data,
          }),
        ),
      },
      user: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockUser())),
      },
      customerWeightApprovalChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
      findById: jest.fn().mockImplementation(() => Promise.resolve(createMockAdjustment())),
      updateActiveState: jest.fn().mockImplementation((id, data) =>
        Promise.resolve({ ...createMockAdjustment(), ...data }),
      ),
    };

    measurementRepoMock = {
      appendMeasurementEvent: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          event: createMockMeasurementEvent({
            revision: input.expectedRevision,
            measuredWeight: new Prisma.Decimal(new Decimal(input.measuredWeight).toFixed(3)),
          }),
          isReplay: false,
        }),
      ),
    };

    service = new SeafoodWeightMeasurementService(
      prismaMock as unknown as PrismaService,
      safetyGateMock as unknown as WeightAdjustmentSafetyGateService,
      adjustmentRepoMock as unknown as SeafoodOrderWeightAdjustmentRepository,
      measurementRepoMock as unknown as SeafoodWeightMeasurementEventRepository,
    );
  });

  describe('Scenario 1: WHOLE_RAW initial weighing and correct price calculation', () => {
    it('records authoritative whole raw measurement within customer ceiling and updates parent projection', async () => {
      // 5.500 lbs @ 1500 = 8,250 JMD subtotal + 500 flat prep = 8,750 JMD total (ceiling is 9500 JMD)
      const result = await service.recordAuthoritativeMeasurement(createValidInput());

      expect(result.status).toBe('MEASURED_WITHIN_CEILING');
      expect(result.requiresCustomerApproval).toBe(false);
      expect(result.customerApprovalStatus).toBe(CustomerWeightApprovalStatus.NOT_REQUIRED);
      expect(result.pricingResult.finalProductSubtotal!.toString()).toBe('8250');
      expect(result.pricingResult.finalPreparationFee!.toString()).toBe('500');
      expect(result.pricingResult.finalItemTotal!.toString()).toBe('8750');

      expect(safetyGateMock.assertLotSafeForFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
        expect.anything(),
      );

      expect(measurementRepoMock.appendMeasurementEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          weightAdjustmentId: validAdjustmentId,
          expectedRevision: 1,
          measuredWeight: new Decimal('5.500'),
          operatorUserId: validOperatorUserId,
        }),
        expect.anything(),
      );

      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validAdjustmentId },
          data: expect.objectContaining({
            verifiedBillableWeight: new Prisma.Decimal('5.500'),
            finalItemTotal: new Prisma.Decimal('8750.00'),
            measurementStatus: WeightMeasurementStatus.MEASURED_WITHIN_CEILING,
            customerApprovalStatus: CustomerWeightApprovalStatus.NOT_REQUIRED,
          }),
        }),
      );
    });
  });

  describe('Scenario 4: Invalid tare or net-weight evidence', () => {
    it('fails closed when measuredWeight is non-positive or zero', async () => {
      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ measuredWeight: '0' })),
      ).rejects.toThrow(InvalidScaleEvidenceError);
    });

    it('fails closed when measuredWeight is NaN or missing', async () => {
      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ measuredWeight: 'invalid-number' })),
      ).rejects.toThrow(InvalidScaleEvidenceError);
    });

    it('fails closed when scalePhotoUrl is empty or missing', async () => {
      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ scalePhotoUrl: '   ' })),
      ).rejects.toThrow(InvalidScaleEvidenceError);
    });

    it('fails closed when tareIsolated is false', async () => {
      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ tareIsolated: false })),
      ).rejects.toThrow(InvalidScaleEvidenceError);
    });
  });

  describe('Scenario 5: Original-lot mismatch and active safety hold', () => {
    it('fails closed with ProvenanceMismatchError when physical lot differs from original purchased lot', async () => {
      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ physicalLotId: 'lot-b-substituted' })),
      ).rejects.toThrow(ProvenanceMismatchError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    it('fails closed with SeafoodSafetyHoldError when safety gate rejects original lot', async () => {
      safetyGateMock.assertLotSafeForFulfillment.mockRejectedValue(
        new SeafoodSafetyHoldError(validLotId, FoodSafetyStatus.SAFETY_HOLD, 'Lot is quarantined'),
      );

      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ idempotencyKey: 'idemp-safety-hold' })),
      ).rejects.toThrow(SeafoodSafetyHoldError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 6: Missing authoritative provenance', () => {
    it('fails closed with MissingAuthoritativeLotProvenanceError when OrderItem lacks persisted lotId', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          orderItem: {
            id: validOrderItemId,
            originalLotId: null, // missing persisted lot
            lotId: null,
            vendorOrder: {
              vendorId: validVendorId,
              vendor: { id: validVendorId, userId: validVendorUserId, status: VendorStatus.APPROVED },
            },
          },
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(createValidInput({ idempotencyKey: 'idemp-missing-lot' })),
      ).rejects.toThrow(MissingAuthoritativeLotProvenanceError);
    });
  });

  describe('Scenario 7: Security Regression Suite — Seller Ownership, Regulatory and Multi-Tenant Isolation', () => {
    // 1. Independent fisherman processes own order
    it('allows approved independent fisherman with FISHERMAN-only role to process their own VendorOrder', async () => {
      const fishermanActor: RequestUser = {
        id: validVendorUserId, // Owns their Vendor account!
        email: 'captain@fisher.com',
        roles: [RoleName.FISHERMAN], // FISHERMAN-only role!
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: createMockFisherman(),
        }),
      );

      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: fishermanActor,
        }),
      );

      expect(result.status).toBe('MEASURED_WITHIN_CEILING');
    });

    // 2. Independent vendor processes own order
    it('allows independent seafood vendor to process their own VendorOrder without fisherman requirements', async () => {
      const vendorActor: RequestUser = {
        id: validVendorUserId,
        email: 'owner@vendor.com',
        roles: [RoleName.VENDOR],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.VENDOR } }],
          fisherman: null,
        }),
      );

      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: vendorActor,
        }),
      );

      expect(result.status).toBe('MEASURED_WITHIN_CEILING');
    });

    // 3. Fisherman cannot operate on another vendor's order even if fisherman.vendorId references that vendor
    it('denies fisherman operating on another vendor order even if fisherman.vendorId references that vendor', async () => {
      const subordinateUserId = 'user-subordinate-fisher';
      const subordinateActor: RequestUser = {
        id: subordinateUserId,
        email: 'crew@boat.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: subordinateUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: createMockFisherman({
            id: 'fish-subordinate',
            userId: subordinateUserId,
            vendorId: validVendorId, // Points to validVendorId, but operator DOES NOT own vendor!
          }),
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: subordinateUserId,
            authenticatedActor: subordinateActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 4. Administrator cannot bypass ownership
    it('denies administrator attempting to process vendor order without owning the vendor account', async () => {
      const adminUserId = 'user-platform-admin';
      const adminActor: RequestUser = {
        id: adminUserId,
        email: 'admin@platform.com',
        roles: [RoleName.ADMINISTRATOR],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: adminUserId,
          roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
          fisherman: null,
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: adminUserId,
            authenticatedActor: adminActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 5. Missing trusted actor fails closed
    it('fails closed when trusted authentication context is omitted entirely', async () => {
      await expect(
        service.recordAuthoritativeMeasurement({
          weightAdjustmentId: validAdjustmentId,
          expectedRevision: 1,
          idempotencyKey: 'idemp-no-actor',
          measuredWeight: '5.500',
          scalePhotoUrl: validPhotoUrl,
          operatorUserId: validVendorUserId,
        }),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 6. Forged operator ID fails closed
    it('rejects request when operatorUserId does not match authenticated actor ID', async () => {
      const attackerActor: RequestUser = {
        id: 'user-attacker',
        email: 'attacker@evil.com',
        roles: [RoleName.VENDOR],
      };

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: validVendorUserId, // Claiming owner ID
            authenticatedActor: attackerActor, // But session is attacker!
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 7. Unverified licence number fails closed
    it('fails closed when fisherman has a nonempty fishingLicenseNumber but no affirmative platform-verified certification', async () => {
      const fisherActor: RequestUser = {
        id: validVendorUserId,
        email: 'unverified-licence@fisher.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: {
            id: 'fish-no-certs',
            userId: validVendorUserId,
            status: FishermanStatus.APPROVED,
            fishingLicenseNumber: 'FL-JM-2026-8891', // Nonempty string alone is NOT proof!
            certifications: [],
          },
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 8. Unrelated active certification fails closed
    it('fails closed when fisherman holds only unrelated active certifications (e.g. Food Handler Permit from MOH)', async () => {
      const fisherActor: RequestUser = {
        id: validVendorUserId,
        email: 'unrelated-cert@fisher.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: {
            id: 'fish-unrelated-cert',
            userId: validVendorUserId,
            status: FishermanStatus.APPROVED,
            fishingLicenseNumber: 'FL-JM-2026-8891',
            certifications: [
              {
                id: 'cert-moh-1',
                fishermanId: 'fish-unrelated-cert',
                certificateType: 'Food Handler Permit', // Unrelated!
                certificateNumber: 'FHP-2026-991',
                issuingAuthorityId: 'auth-moh-1',
                issuedDate: new Date('2026-01-01'),
                expiryDate: new Date('2027-01-01'),
                status: CertificationStatus.ACTIVE,
                issuingAuthority: {
                  id: 'auth-moh-1',
                  name: 'Ministry of Health', // Unrelated authority!
                  country: 'Jamaica',
                },
              },
            ],
          },
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 9. Expired or revoked required licence fails closed
    it('fails closed when fisherman fisheries licence is REVOKED or EXPIRED', async () => {
      const fisherActor: RequestUser = {
        id: validVendorUserId,
        email: 'revoked@fisher.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: {
            id: 'fish-revoked',
            userId: validVendorUserId,
            status: FishermanStatus.APPROVED,
            fishingLicenseNumber: 'FL-OLD-1',
            certifications: [
              createMockFishermanCertification({
                status: CertificationStatus.REVOKED, // Revoked!
              }),
            ],
          },
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });

    // 10. Verified eligible fisherman succeeds
    it('authorizes verified eligible fisherman with approved profile and active NFA commercial fisheries licence', async () => {
      const fishermanActor: RequestUser = {
        id: validVendorUserId,
        email: 'captain@fisher.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: createMockFisherman(),
        }),
      );

      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: fishermanActor,
          measuredWeight: '5.500',
        }),
      );

      expect(result.status).toBe('MEASURED_WITHIN_CEILING');
      expect(result.pricingResult.verifiedBillableWeight!.toString()).toBe('5.5');
    });

    // 11. Ordinary retailer is not incorrectly subjected to fishing licence checks
    it('authorizes ordinary seafood retailer owning vendor without requiring fisherman profile or fishing licence', async () => {
      const retailerActor: RequestUser = {
        id: validVendorUserId,
        email: 'retailer@market.com',
        roles: [RoleName.VENDOR], // VENDOR only, not a fisherman
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.VENDOR } }],
          fisherman: null, // No fisherman profile, and NONE required!
        }),
      );

      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: retailerActor,
        }),
      );

      expect(result.status).toBe('MEASURED_WITHIN_CEILING');
    });

    // 12. Unauthorized attempts produce zero writes
    it('proves authorization denial produces zero measurement writes or updates', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        service.recordAuthoritativeMeasurement(createValidInput()),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
      expect(prismaMock.seafoodOrderWeightAdjustment.update).not.toHaveBeenCalled();
    });

    // 13. Fisherman cannot access another fisherman's order
    it('denies independent fisherman attempting to process another fisherman vendor order', async () => {
      const otherFishermanId = 'user-other-fisherman';
      const otherFishermanActor: RequestUser = {
        id: otherFishermanId,
        email: 'other@fisher.com',
        roles: [RoleName.FISHERMAN],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: otherFishermanId,
          roles: [{ role: { name: RoleName.FISHERMAN } }],
          fisherman: createMockFisherman({
            id: 'fish-profile-other',
            userId: otherFishermanId,
          }),
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            operatorUserId: otherFishermanId,
            authenticatedActor: otherFishermanActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedMeasurementOperatorError);

      expect(measurementRepoMock.appendMeasurementEvent).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 8: Duplicate measurement idempotency', () => {
    it('returns existing event with isReplay: true on identical idempotencyKey', async () => {
      const existingEvent = createMockMeasurementEvent();
      measurementRepoMock.appendMeasurementEvent.mockResolvedValue({
        event: existingEvent,
        isReplay: true,
      });

      const result = await service.recordAuthoritativeMeasurement(createValidInput());

      expect(result.status).toBe('IDEMPOTENT_REPLAY');
      expect(result.isReplay).toBe(true);
      expect(result.measurementEvent).toEqual(existingEvent);
      expect(prismaMock.seafoodOrderWeightAdjustment.update).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 9: Concurrent measurement revision conflict', () => {
    it('throws StaleRevisionConflictError when expectedRevision does not match currentRevision + 1', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activeMeasurementRevision: 2,
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            expectedRevision: 2,
            idempotencyKey: 'idemp-stale',
            correctionReason: 'Correcting weight',
          }),
        ),
      ).rejects.toThrow(StaleRevisionConflictError);
    });
  });

  describe('Scenario 10: Correction without reason', () => {
    it('throws MissingCorrectionReasonError when revision > 1 has empty correctionReason', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activeMeasurementRevision: 1,
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            expectedRevision: 2,
            idempotencyKey: 'idemp-corr-no-reason',
            measuredWeight: '5.600',
            correctionReason: '   ',
          }),
        ),
      ).rejects.toThrow(MissingCorrectionReasonError);
    });
  });

  describe('Scenario 11: Correction after preparation commenced or indeterminate commencement', () => {
    it('throws MeasurementCorrectionProhibitedError when preparation is already fulfilled under WHOLE_RAW', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activeMeasurementRevision: 1,
          activePreparationRevision: 1,
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            expectedRevision: 2,
            idempotencyKey: 'idemp-corr-prep-done',
            measuredWeight: '5.600',
            correctionReason: 'Misread scale on rev 1',
          }),
        ),
      ).rejects.toThrow(MeasurementCorrectionProhibitedError);
    });

    it('fails closed with PreparationCommencementIndeterminateError when commencement state cannot be proven under WHOLE_RAW', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activeMeasurementRevision: 1,
          activePreparationRevision: null,
        }),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({
            expectedRevision: 2,
            idempotencyKey: 'idemp-corr-indeterminate',
            measuredWeight: '5.600',
            correctionReason: 'Platform tare error',
          }),
        ),
      ).rejects.toThrow(PreparationCommencementIndeterminateError);
    });
  });

  describe('Scenario 12: Approval invalidation on correction', () => {
    it('invalidates prior approval and revokes open challenges when valid correction is recorded', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          pricingBasis: SeafoodPricingBasis.DRESSED,
          activeMeasurementRevision: 1,
          boundApprovalRevision: 1,
          customerApprovalStatus: CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
        }),
      );

      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          expectedRevision: 2,
          idempotencyKey: 'idemp-corr-dressed',
          measuredWeight: '5.600',
          correctionReason: 'Scale platform recalibrated',
        }),
      );

      expect(prismaMock.customerWeightApprovalChallenge.updateMany).toHaveBeenCalledWith({
        where: {
          weightAdjustmentId: validAdjustmentId,
          status: ApprovalChallengeStatus.OPEN,
        },
        data: expect.objectContaining({
          status: ApprovalChallengeStatus.REVOKED,
          revocationReason: 'SUPERSEDED_BY_MEASUREMENT_CORRECTION',
        }),
      });

      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            boundApprovalRevision: null,
          }),
        }),
      );
    });
  });

  describe('Scenario 13: Above-ceiling measurement requiring approval', () => {
    it('sets AWAITING_APPROVAL and MEASURED_EXCEEDS_CEILING when measured total exceeds authorized ceiling', async () => {
      const result = await service.recordAuthoritativeMeasurement(
        createValidInput({
          expectedRevision: 1,
          idempotencyKey: 'idemp-heavy',
          measuredWeight: '7.000',
        }),
      );

      expect(result.status).toBe('MEASURED_EXCEEDS_CEILING');
      expect(result.requiresCustomerApproval).toBe(true);
      expect(result.customerApprovalStatus).toBe(CustomerWeightApprovalStatus.AWAITING_APPROVAL);

      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            measurementStatus: WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING,
            customerApprovalStatus: CustomerWeightApprovalStatus.AWAITING_APPROVAL,
            finalItemTotal: new Prisma.Decimal('11000.00'),
          }),
        }),
      );
    });
  });

  describe('Scenario 18a: Transaction failure with no partial persistence', () => {
    it('propagates database error and prevents partial execution', async () => {
      prismaMock.seafoodOrderWeightAdjustment.update.mockRejectedValue(
        new Error('PostgreSQL deadlock detected'),
      );

      await expect(
        service.recordAuthoritativeMeasurement(
          createValidInput({ idempotencyKey: 'idemp-deadlock' }),
        ),
      ).rejects.toThrow('PostgreSQL deadlock detected');
    });
  });
});
