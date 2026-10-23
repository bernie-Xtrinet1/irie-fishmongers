import {
  CertificationStatus,
  FishermanStatus,
  FoodSafetyStatus,
  PreparationFeeStructure,
  Prisma,
  ProductUnit,
  RoleName,
  SeafoodPricingBasis,
  UsablePartsFulfillmentOutcome,
  UserStatus,
  VendorStatus,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { RequestUser } from '../../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../../database/prisma.service';
import { PreparedWeightExceedsBillableError } from '../../domain/seafood-pricing-engine.errors';
import {
  AdjustmentNotFoundError,
  MissingAuthoritativeLotProvenanceError,
  ProvenanceMismatchError,
  SeafoodSafetyHoldError,
  StaleRevisionConflictError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { SeafoodOrderWeightAdjustmentRepository } from '../../repositories/seafood-order-weight-adjustment.repository';
import { SeafoodPreparationFulfillmentEventRepository } from '../../repositories/seafood-preparation-fulfillment-event.repository';
import { SeafoodPreparationFulfillmentService } from '../seafood-preparation-fulfillment.service';
import {
  InvalidPreparationWeightError,
  InvalidUsablePartsOutcomeError,
  PreparationServiceMismatchError,
  UnauthorizedPreparationOperatorError,
  UnmeasuredPreparationError,
  UnselectedPreparationError,
} from '../types/weight-measurement-fulfillment.types';
import { WeightAdjustmentSafetyGateService } from '../weight-adjustment-safety-gate.service';

/**
 * Phase 16D WP3.3: Seafood Preparation Fulfillment Service Unit & Security Tests
 */
describe('SeafoodPreparationFulfillmentService', () => {
  let service: SeafoodPreparationFulfillmentService;
  let prismaMock: any;
  let safetyGateMock: any;
  let adjustmentRepoMock: any;
  let preparationRepoMock: any;

  const validAdjustmentId = 'adj-101';
  const validOrderItemId = 'item-101';
  const validVendorId = 'vendor-fishmonger-1';
  const validVendorUserId = 'user-vendor-owner';
  const validOperatorUserId = validVendorUserId; // Default operator is the authorized vendor owner
  const validLotId = 'lot-a-snapper';

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
    unitPrice: new Prisma.Decimal('1500.00'),
    estimatedBillableWeight: new Prisma.Decimal('5.000'),
    verifiedBillableWeight: new Prisma.Decimal('5.500'), // already measured!
    finalProductSubtotal: new Prisma.Decimal('8250.00'), // 5.5 * 1500 = 8250
    finalPreparationFee: new Prisma.Decimal('500.00'),
    finalItemTotal: new Prisma.Decimal('8750.00'),
    preparationServiceName: 'Scaled & Gutted',
    activeMeasurementRevision: 1, // Measured!
    activePreparationRevision: null,
    measurementStatus: WeightMeasurementStatus.MEASURED_WITHIN_CEILING,
    usablePartsOutcome: null,
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

  const createMockPreparationEvent = (overrides: any = {}) => ({
    id: 'event-prep-1',
    weightAdjustmentId: validAdjustmentId,
    revision: 1,
    idempotencyKey: 'idemp-prep-1',
    payloadHash: 'hash-prep-1',
    preparedNetWeight: new Prisma.Decimal('4.500'),
    partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
    partsDisposalReason: null,
    preparedPhotoUrl: 'https://s3.amazonaws.com/prep-photos/snap-prep-1.jpg',
    operatorUserId: validOperatorUserId,
    correctionReason: null,
    recordedAt: new Date(),
    ...overrides,
  });

  const createValidInput = (overrides: any = {}) => ({
    weightAdjustmentId: validAdjustmentId,
    expectedRevision: 1,
    idempotencyKey: 'idemp-prep-1',
    operatorUserId: validOperatorUserId,
    authenticatedActor: validActor,
    preparationServiceName: 'Scaled & Gutted',
    partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
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

    preparationRepoMock = {
      appendPreparationEvent: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          event: createMockPreparationEvent({
            revision: input.expectedRevision,
            partsOutcome: input.partsOutcome,
            preparedNetWeight: input.preparedNetWeight
              ? new Prisma.Decimal(new Decimal(input.preparedNetWeight).toFixed(3))
              : null,
          }),
          isReplay: false,
        }),
      ),
    };

    service = new SeafoodPreparationFulfillmentService(
      prismaMock as unknown as PrismaService,
      safetyGateMock as unknown as WeightAdjustmentSafetyGateService,
      adjustmentRepoMock as unknown as SeafoodOrderWeightAdjustmentRepository,
      preparationRepoMock as unknown as SeafoodPreparationFulfillmentEventRepository,
    );
  });

  describe('Scenario 2: No post-preparation billing reweigh (WHOLE_RAW billing permanence)', () => {
    it('records preparation fulfillment without altering WHOLE_RAW customer subtotal, prep fee, or item total', async () => {
      const result = await service.recordPreparationFulfillment(createValidInput());

      expect(result.status).toBe('FULFILLED');
      expect(result.isReplay).toBe(false);

      expect(safetyGateMock.assertLotSafeForFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
        expect.anything(),
      );

      // Verify that preparation update NEVER writes new financial values
      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: validAdjustmentId },
          data: expect.not.objectContaining({
            finalProductSubtotal: expect.anything(),
            finalPreparationFee: expect.anything(),
            finalItemTotal: expect.anything(),
          }),
        }),
      );
    });
  });

  describe('Scenario 3: Optional prepared weight with unit validation and QC yield loss metrics', () => {
    it('records prepared net weight with matching unit and calculates yield loss for QC without altering customer price', async () => {
      // verified billable whole raw weight = 5.500 lbs; prepared net weight = 4.400 lbs
      // yield loss = 1.100 lbs (20.00% yield loss)
      const result = await service.recordPreparationFulfillment(
        createValidInput({
          preparedNetWeight: '4.400',
          unit: WeightUnit.POUNDS,
        }),
      );

      expect(result.status).toBe('FULFILLED');
      expect(result.yieldLossWeight!.toString()).toBe('1.1');
      expect(result.yieldLossPercent!.toString()).toBe('20');

      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            preparedNetWeight: new Prisma.Decimal('4.400'),
            yieldLossWeight: new Prisma.Decimal('1.100'),
            yieldLossPercent: new Prisma.Decimal('20.00'),
          }),
        }),
      );
    });

    it('rejects prepared weight when measurement unit is omitted', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            preparedNetWeight: '4.400',
          }),
        ),
      ).rejects.toThrow(InvalidPreparationWeightError);
    });

    it('rejects prepared weight when measurement unit does not match order adjustment unit', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            preparedNetWeight: '4.400',
            unit: WeightUnit.KILOGRAMS, // Mismatched! Adjustment is in POUNDS
          }),
        ),
      ).rejects.toThrow(InvalidPreparationWeightError);
    });

    it('fails closed when prepared weight exceeds verified whole raw billable catch weight', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            preparedNetWeight: '6.000',
            unit: WeightUnit.POUNDS,
          }),
        ),
      ).rejects.toThrow(PreparedWeightExceedsBillableError);
    });
  });

  describe('Scenario 5b: Original-lot mismatch and active safety hold before preparation', () => {
    it('fails closed with ProvenanceMismatchError when physical lot differs from original purchased lot', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({ physicalLotId: 'lot-b-substituted' }),
        ),
      ).rejects.toThrow(ProvenanceMismatchError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });

    it('fails closed with SeafoodSafetyHoldError when safety gate rejects original lot before preparation', async () => {
      safetyGateMock.assertLotSafeForFulfillment.mockRejectedValue(
        new SeafoodSafetyHoldError(validLotId, FoodSafetyStatus.SAFETY_HOLD, 'Quarantined lot'),
      );

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow(SeafoodSafetyHoldError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 6b: Missing authoritative provenance', () => {
    it('fails closed with MissingAuthoritativeLotProvenanceError when OrderItem lacks persisted lotId', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          orderItem: {
            id: validOrderItemId,
            originalLotId: null,
            lotId: null,
            vendorOrder: {
              vendorId: validVendorId,
              vendor: { id: validVendorId, userId: validVendorUserId, status: VendorStatus.APPROVED },
            },
          },
        }),
      );

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow(MissingAuthoritativeLotProvenanceError);
    });
  });

  describe('Scenario 7b: Security Regression Suite — Seller Ownership, Regulatory and Multi-Tenant Preparation Isolation', () => {
    // 1. Independent fisherman processes own order
    it('allows approved independent fisherman with FISHERMAN-only role to fulfill preparation on their own order', async () => {
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

      const result = await service.recordPreparationFulfillment(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: fishermanActor,
        }),
      );

      expect(result.status).toBe('FULFILLED');
    });

    // 2. Independent vendor processes own order
    it('allows independent seafood vendor to fulfill preparation on their own VendorOrder without fisherman requirements', async () => {
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

      const result = await service.recordPreparationFulfillment(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: vendorActor,
        }),
      );

      expect(result.status).toBe('FULFILLED');
    });

    // 3. Fisherman cannot operate on another vendor's order even if fisherman.vendorId references that vendor
    it('denies fisherman fulfilling preparation on another vendor order even if fisherman.vendorId references that vendor', async () => {
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
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: subordinateUserId,
            authenticatedActor: subordinateActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });

    // 4. Administrator cannot bypass ownership
    it('denies administrator attempting to fulfill preparation on vendor order without owning the vendor account', async () => {
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
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: adminUserId,
            authenticatedActor: adminActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });

    // 5. Missing trusted actor fails closed
    it('fails closed when trusted authentication context is omitted entirely', async () => {
      await expect(
        service.recordPreparationFulfillment({
          weightAdjustmentId: validAdjustmentId,
          expectedRevision: 1,
          idempotencyKey: 'idemp-prep-no-actor',
          operatorUserId: validVendorUserId,
          partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
        }),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });

    // 6. Forged operator ID fails closed
    it('rejects request when operatorUserId does not match authenticated actor ID', async () => {
      const attackerActor: RequestUser = {
        id: 'user-attacker',
        email: 'attacker@evil.com',
        roles: [RoleName.VENDOR],
      };

      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: attackerActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
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
            fishingLicenseNumber: 'FL-JM-2026-8891',
            certifications: [],
          },
        }),
      );

      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
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
                certificateType: 'Food Handler Permit',
                certificateNumber: 'FHP-2026-991',
                issuingAuthorityId: 'auth-moh-1',
                issuedDate: new Date('2026-01-01'),
                expiryDate: new Date('2027-01-01'),
                status: CertificationStatus.ACTIVE,
                issuingAuthority: {
                  id: 'auth-moh-1',
                  name: 'Ministry of Health',
                  country: 'Jamaica',
                },
              },
            ],
          },
        }),
      );

      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
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
                status: CertificationStatus.REVOKED,
              }),
            ],
          },
        }),
      );

      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: validVendorUserId,
            authenticatedActor: fisherActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
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

      const result = await service.recordPreparationFulfillment(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: fishermanActor,
        }),
      );

      expect(result.status).toBe('FULFILLED');
    });

    // 11. Ordinary retailer is not incorrectly subjected to fishing licence checks
    it('authorizes ordinary seafood retailer owning vendor without requiring fisherman profile or fishing licence', async () => {
      const retailerActor: RequestUser = {
        id: validVendorUserId,
        email: 'retailer@market.com',
        roles: [RoleName.VENDOR],
      };

      prismaMock.user.findUnique.mockResolvedValue(
        createMockUser({
          id: validVendorUserId,
          roles: [{ role: { name: RoleName.VENDOR } }],
          fisherman: null,
        }),
      );

      const result = await service.recordPreparationFulfillment(
        createValidInput({
          operatorUserId: validVendorUserId,
          authenticatedActor: retailerActor,
        }),
      );

      expect(result.status).toBe('FULFILLED');
    });

    // 12. Unauthorized attempts produce zero writes
    it('proves authorization denial produces no preparation writes or updates', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
      expect(prismaMock.seafoodOrderWeightAdjustment.update).not.toHaveBeenCalled();
    });

    // 13. Fisherman cannot access another fisherman's order
    it('denies independent fisherman attempting to fulfill preparation on another fisherman vendor order', async () => {
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
        service.recordPreparationFulfillment(
          createValidInput({
            operatorUserId: otherFishermanId,
            authenticatedActor: otherFishermanActor,
          }),
        ),
      ).rejects.toThrow(UnauthorizedPreparationOperatorError);

      expect(preparationRepoMock.appendPreparationEvent).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 8b: Duplicate preparation idempotency', () => {
    it('returns existing event with isReplay: true on identical idempotencyKey', async () => {
      const existingEvent = createMockPreparationEvent();
      preparationRepoMock.appendPreparationEvent.mockResolvedValue({
        event: existingEvent,
        isReplay: true,
      });

      const result = await service.recordPreparationFulfillment(createValidInput());

      expect(result.status).toBe('IDEMPOTENT_REPLAY');
      expect(result.isReplay).toBe(true);
      expect(result.preparationEvent).toEqual(existingEvent);
      expect(prismaMock.seafoodOrderWeightAdjustment.update).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 14: Preparation without prior measurement', () => {
    it('fails closed with UnmeasuredPreparationError when adjustment is unmeasured', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activeMeasurementRevision: null,
          measurementStatus: WeightMeasurementStatus.PENDING_MEASUREMENT,
          verifiedBillableWeight: null,
        }),
      );

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow(UnmeasuredPreparationError);
    });
  });

  describe('Scenario 14b: Customer preparation selection verification', () => {
    it('fails closed with UnselectedPreparationError when customer did not select preparation', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          preparationServiceName: null,
        }),
      );

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow(UnselectedPreparationError);
    });

    it('fails closed with PreparationServiceMismatchError when requested service does not match customer selection', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            preparationServiceName: 'Whole Cleaned',
          }),
        ),
      ).rejects.toThrow(PreparationServiceMismatchError);
    });
  });

  describe('Scenario 15: Invalid parts outcomes', () => {
    it('fails closed with InvalidUsablePartsOutcomeError when outcome is invalid', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({ partsOutcome: 'INVALID_OUTCOME' as any }),
        ),
      ).rejects.toThrow(InvalidUsablePartsOutcomeError);
    });
  });

  describe('Scenario 16: Unsuitable-parts disposal without customer reapproval', () => {
    it('requires partsDisposalReason when parts are not suitable, but does not alter customer billing or require re-approval', async () => {
      const result = await service.recordPreparationFulfillment(
        createValidInput({
          partsOutcome: UsablePartsFulfillmentOutcome.NO_SUITABLE_PARTS_AVAILABLE,
          partsDisposalReason: 'Bile sac ruptured during gutting; frames contaminated and unsuitable for consumption',
        }),
      );

      expect(result.status).toBe('FULFILLED');
      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            usablePartsOutcome: UsablePartsFulfillmentOutcome.NO_SUITABLE_PARTS_AVAILABLE,
          }),
        }),
      );
    });

    it('fails closed when NO_SUITABLE_PARTS_AVAILABLE is recorded without a disposal reason', async () => {
      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            partsOutcome: UsablePartsFulfillmentOutcome.NO_SUITABLE_PARTS_AVAILABLE,
            partsDisposalReason: '   ',
          }),
        ),
      ).rejects.toThrow(InvalidUsablePartsOutcomeError);
    });
  });

  describe('Scenario 17: Stale preparation revision', () => {
    it('fails closed with StaleRevisionConflictError when expectedRevision does not match currentRevision + 1', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(
        createMockAdjustment({
          activePreparationRevision: 1,
        }),
      );

      await expect(
        service.recordPreparationFulfillment(
          createValidInput({
            expectedRevision: 1,
          }),
        ),
      ).rejects.toThrow(StaleRevisionConflictError);
    });
  });

  describe('Scenario 18b: Transaction failure with no partial persistence', () => {
    it('propagates database error and prevents partial execution', async () => {
      prismaMock.seafoodOrderWeightAdjustment.update.mockRejectedValue(
        new Error('PostgreSQL deadlock detected'),
      );

      await expect(
        service.recordPreparationFulfillment(createValidInput()),
      ).rejects.toThrow('PostgreSQL deadlock detected');
    });
  });
});
