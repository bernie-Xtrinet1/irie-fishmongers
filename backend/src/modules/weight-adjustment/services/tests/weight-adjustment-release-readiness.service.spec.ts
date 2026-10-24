import { Test, TestingModule } from '@nestjs/testing';
import {
  CertificationStatus,
  CustomerWeightApprovalStatus,
  FishermanStatus,
  FoodSafetyStatus,
  PaymentObligationDirection,
  PaymentProviderName,
  Prisma,
  RoleName,
  VendorStatus,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  SeafoodLotRecalledError,
  SeafoodSafetyHoldError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { WeightAdjustmentSafetyGateService } from '../weight-adjustment-safety-gate.service';
import { WeightAdjustmentSettlementService } from '../weight-adjustment-settlement.service';
import { WeightAdjustmentReleaseReadinessService } from '../weight-adjustment-release-readiness.service';
import { EvaluateReleaseReadinessInput } from '../types/weight-adjustment-coordination.types';

describe('WeightAdjustmentReleaseReadinessService', () => {
  let service: WeightAdjustmentReleaseReadinessService;
  let prismaMock: any;
  let safetyGateMock: any;
  let settlementServiceMock: any;

  const createMockFullAdjustment = (overrides?: Record<string, any>) => ({
    id: 'adj-001',
    orderItemId: 'item-001',
    unit: WeightUnit.POUNDS,
    activeMeasurementRevision: 1,
    measurementStatus: WeightMeasurementStatus.MEASURED_WITHIN_CEILING,
    verifiedBillableWeight: new Prisma.Decimal('5.250'),
    preparationServiceName: 'Filleting',
    activePreparationRevision: 1,
    preparedNetWeight: new Prisma.Decimal('3.750'),
    customerAuthorizedCeilingJmd: new Prisma.Decimal('2000.00'),
    finalItemTotal: new Prisma.Decimal('1800.00'),
    customerApprovalStatus: CustomerWeightApprovalStatus.NOT_REQUIRED,
    boundApprovalRevision: null,
    foodSafetyStatus: FoodSafetyStatus.SAFE,
    orderItem: {
      id: 'item-001',
      originalLotId: 'lot-001',
      originalListingId: 'listing-001',
      product: {
        id: 'prod-001',
        lotId: 'lot-001',
        lot: {
          id: 'lot-001',
          lotNumber: 'LOT-20261024-001',
          foodSafetyStatus: FoodSafetyStatus.SAFE,
        },
      },
      vendorOrder: {
        id: 'vo-001',
        delivery: {
          id: 'del-001',
          vendorOrderId: 'vo-001',
          driverId: 'drv-001',
          driver: {
            id: 'drv-001',
            userId: 'user-driver-1',
          },
        },
        vendor: {
          id: 'vendor-123',
          userId: 'user-vendor-1',
          status: VendorStatus.APPROVED,
          user: {
            id: 'user-vendor-1',
            roles: [{ role: { name: RoleName.VENDOR } }],
            fisherman: null,
          },
        },
        order: {
          id: 'order-001',
          customerId: 'cust-123',
          payment: {
            id: 'pay-001',
            provider: PaymentProviderName.WIPAY,
            status: 'PAID',
          },
        },
      },
    },
    financialObligations: [
      {
        id: 'ob-001',
        revision: 1,
        direction: PaymentObligationDirection.NONE,
        amountJmd: new Prisma.Decimal('0.00'),
      },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    prismaMock = {
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockResolvedValue(createMockFullAdjustment()),
      },
    };

    safetyGateMock = {
      assertLotSafeForFulfillment: jest.fn().mockResolvedValue(undefined),
    };

    settlementServiceMock = {
      getObligationBalance: jest.fn().mockResolvedValue({
        obligationId: 'ob-001',
        totalAmountJmd: '0.00',
        totalSettledJmd: '0.00',
        remainingBalanceJmd: '0.00',
        isFullySettled: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeightAdjustmentReleaseReadinessService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: WeightAdjustmentSafetyGateService, useValue: safetyGateMock },
        { provide: WeightAdjustmentSettlementService, useValue: settlementServiceMock },
      ],
    }).compile();

    service = module.get<WeightAdjustmentReleaseReadinessService>(
      WeightAdjustmentReleaseReadinessService,
    );
  });

  describe('Happy Path Execution', () => {
    it('TC-WP3.4-REL-01: returns dispatchReady: true and handoverReady: true when all 5 gates pass', async () => {
      const input: EvaluateReleaseReadinessInput = {
        weightAdjustmentId: 'adj-001',
      };

      const result = await service.evaluateReleaseReadiness(input);

      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(true);
      expect(result.gate1Measurement.status).toBe('PASSED');
      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('PASSED');
      expect(result.gate3CustomerApproval.status).toBe('PASSED');
      expect(result.gate4PreparationFulfillment.status).toBe('PASSED');
      expect(result.gate5FinancialSettlement.status).toBe('PASSED');
    });
  });

  describe('Gate 1: Scale Measurement Verification', () => {
    it('TC-WP3.4-REL-02: blocks release when scale measurement is PENDING_MEASUREMENT', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          measurementStatus: WeightMeasurementStatus.PENDING_MEASUREMENT,
          activeMeasurementRevision: null,
          verifiedBillableWeight: null,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate1Measurement.status).toBe('BLOCKED');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-03: blocks release when verified weight is zero or negative', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          verifiedBillableWeight: new Prisma.Decimal('0.000'),
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate1Measurement.status).toBe('BLOCKED');
      expect(result.dispatchReady).toBe(false);
    });
  });

  describe('Gate 2: Live Food Safety & Regulatory Verification', () => {
    it('TC-WP3.4-REL-04 (Test 16): blocks release when previously safe lot is recalled before release evaluation', async () => {
      safetyGateMock.assertLotSafeForFulfillment.mockRejectedValueOnce(
        new SeafoodLotRecalledError('lot-001', 'Active recall detected on batch LOT-20261024-001'),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain('Active recall detected');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-06A (Test 5): blocks release when original lot identifier is missing from order item', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            originalLotId: null,
            lotId: null,
          },
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain('Missing authoritative original-lot provenance');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-06B (Test 6): blocks release when original listing identifier is missing from order item', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            originalListingId: null,
            listingId: null,
          },
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain('Missing authoritative original-listing provenance');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-06C (Test 7): mutable product lot changed after checkout fails closed against original lot', async () => {
      // Product record in database has lotId mutated to a "safe" lot ('lot-rotated-999'),
      // but the original purchased order item provenance is lot-001, which is recalled.
      safetyGateMock.assertLotSafeForFulfillment.mockImplementationOnce(
        async (input: { seafoodLotId: string }) => {
          if (input.seafoodLotId === 'lot-001') {
            throw new SeafoodLotRecalledError('lot-001', 'Original lot LOT-001 was recalled');
          }
        },
      );

      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            originalLotId: 'lot-001',
            originalListingId: 'listing-001',
            product: {
              id: 'prod-001',
              lotId: 'lot-rotated-999', // mutated after checkout!
              lot: {
                id: 'lot-rotated-999',
                foodSafetyStatus: FoodSafetyStatus.SAFE,
              },
            },
          },
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain('Original lot LOT-001 was recalled');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
      expect(safetyGateMock.assertLotSafeForFulfillment).toHaveBeenCalledWith(
        expect.objectContaining({ seafoodLotId: 'lot-001' }),
        expect.anything(),
      );
    });

    it('TC-WP3.4-REL-05: blocks release when vendor account is suspended', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              vendor: {
                ...createMockFullAdjustment().orderItem.vendorOrder.vendor,
                status: VendorStatus.SUSPENDED,
              },
            },
          },
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain('is not approved');
      expect(result.dispatchReady).toBe(false);
    });

    it('TC-WP3.4-REL-06: blocks release when fisherman vendor regulatory licence is expired or suspended', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              vendor: {
                ...createMockFullAdjustment().orderItem.vendorOrder.vendor,
                user: {
                  id: 'user-fisherman-1',
                  roles: [{ role: { name: RoleName.FISHERMAN } }],
                  fisherman: {
                    id: 'fm-001',
                    status: FishermanStatus.APPROVED,
                    certifications: [
                      {
                        certificateType: 'NFA_COMMERCIAL_FISHER_LICENCE',
                        status: CertificationStatus.EXPIRED,
                        expiryDate: new Date(Date.now() - 86400_000), // Expired yesterday
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(result.gate2FoodSafetyAndRegulatory.details).toContain(
        'Fisherman lacks an active, unexpired commercial fisheries licence',
      );
      expect(result.dispatchReady).toBe(false);
    });
  });

  describe('Gate 3: Customer Approval Verification', () => {
    it('TC-WP3.4-REL-07: passes when customer approval is NOT_REQUIRED', async () => {
      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });
      expect(result.gate3CustomerApproval.status).toBe('PASSED');
    });

    it('TC-WP3.4-REL-08: passes when customer approved and revision matches active measurement revision', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
          boundApprovalRevision: 1,
          activeMeasurementRevision: 1,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate3CustomerApproval.status).toBe('PASSED');
      expect(result.gate3CustomerApproval.details).toContain('Approved by customer on active revision 1');
    });

    it('TC-WP3.4-REL-09: blocks release when customer approval is bound to stale revision', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
          boundApprovalRevision: 1,
          activeMeasurementRevision: 2, // Vendor re-weighed after approval
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate3CustomerApproval.status).toBe('BLOCKED');
      expect(result.gate3CustomerApproval.details).toContain('bound to revision 1, but active measurement revision is 2');
      expect(result.dispatchReady).toBe(false);
    });

    it('TC-WP3.4-REL-10: blocks release when customer approval is pending', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.AWAITING_APPROVAL,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate3CustomerApproval.status).toBe('BLOCKED');
      expect(result.dispatchReady).toBe(false);
    });

    it('TC-WP3.4-REL-11: marks gate REJECTED when customer explicitly rejected adjustment', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.REJECTED_BY_CUSTOMER,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate3CustomerApproval.status).toBe('REJECTED');
      expect(result.dispatchReady).toBe(false);
    });

    it('TC-WP3.4-REL-12: marks gate EXPIRED when customer challenge expired without decision', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.AUTO_EXPIRED,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate3CustomerApproval.status).toBe('EXPIRED');
      expect(result.dispatchReady).toBe(false);
    });
  });

  describe('Gate 4: Preparation Fulfillment Verification', () => {
    it('TC-WP3.4-REL-13: marks gate NOT_REQUIRED when no preparation service requested', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          preparationServiceName: null,
          activePreparationRevision: null,
          preparedNetWeight: null,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate4PreparationFulfillment.status).toBe('NOT_REQUIRED');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(true);
    });

    it('TC-WP3.4-REL-14: blocks release when preparation requested but unfulfilled', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          preparationServiceName: 'Filleting',
          activePreparationRevision: null,
          preparedNetWeight: null,
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate4PreparationFulfillment.status).toBe('BLOCKED');
      expect(result.dispatchReady).toBe(false);
    });
  });

  describe('Gate 5: Financial Settlement Disposition & Dispatch vs Handover', () => {
    it('TC-WP3.4-REL-15A (Test 1): blocks release when prepaid order base payment is UNPAID (PENDING) even with neutral adjustment', async () => {
      // Customer has a neutral weight adjustment, but base order payment was never confirmed PAID
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.WIPAY,
                  status: 'PENDING', // Unpaid base order!
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-none-1',
              revision: 1,
              direction: PaymentObligationDirection.NONE,
              amountJmd: new Prisma.Decimal('0.00'),
            },
          ],
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('BLOCKED');
      expect(result.gate5FinancialSettlement.details).toContain('not confirmed PAID');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-15B (Test 2): blocks release when prepaid order base payment is UNPAID (FAILED) even with customer credit queued', async () => {
      // Customer has a credit due from catch under-weight, but base order payment failed
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.WIPAY,
                  status: 'FAILED', // Failed base payment!
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-credit-1',
              revision: 1,
              direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
              amountJmd: new Prisma.Decimal('200.00'),
            },
          ],
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('BLOCKED');
      expect(result.gate5FinancialSettlement.details).toContain('not confirmed PAID');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-15: does NOT block release when customer credit memo is queued on a PAID prepaid order', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          financialObligations: [
            {
              id: 'ob-credit-1',
              revision: 1,
              direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
              amountJmd: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('PASSED_CREDIT_QUEUED');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(true);
    });

    it('TC-WP3.4-REL-16: passes both dispatch and handover when supplemental obligation is fully settled on a PAID prepaid order', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          financialObligations: [
            {
              id: 'ob-supp-1',
              revision: 1,
              direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
              amountJmd: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );

      settlementServiceMock.getObligationBalance.mockResolvedValueOnce({
        obligationId: 'ob-supp-1',
        totalAmountJmd: '300.00',
        totalSettledJmd: '300.00',
        remainingBalanceJmd: '0.00',
        isFullySettled: true,
      });

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('PASSED');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(true);
    });

    it('TC-WP3.4-REL-17 (Test 4): blocks both dispatch and handover when paid prepaid order has unpaid supplemental balance', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          financialObligations: [
            {
              id: 'ob-supp-1',
              revision: 1,
              direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
              amountJmd: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );

      settlementServiceMock.getObligationBalance.mockResolvedValueOnce({
        obligationId: 'ob-supp-1',
        totalAmountJmd: '300.00',
        totalSettledJmd: '0.00',
        remainingBalanceJmd: '300.00',
        isFullySettled: false,
      });

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('BLOCKED');
      expect(result.dispatchReady).toBe(false);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-18A (Test 8): permits dispatch but blocks handover for COD neutral adjustment with no cash receipt', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.CASH_ON_DELIVERY,
                  status: 'PENDING', // no cash receipt recorded yet
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-cod-none',
              revision: 1,
              direction: PaymentObligationDirection.NONE,
              amountJmd: new Prisma.Decimal('0.00'),
            },
          ],
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(result.dispatchReady).toBe(true); // driver may be dispatched with order
      expect(result.handoverReady).toBe(false); // customer handover strictly blocked until cash collected
    });

    it('TC-WP3.4-REL-18B (Test 9): permits dispatch but blocks handover for COD credit adjustment with no cash receipt', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.CASH_ON_DELIVERY,
                  status: 'PENDING',
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-cod-credit',
              revision: 1,
              direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
              amountJmd: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-18C (Test 10): blocks handover when COD receipt covers only the supplement while base order cash is uncollected', async () => {
      // Driver recorded receipt for the extra weight, but base order payment has no cash receipt
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.CASH_ON_DELIVERY,
                  status: 'PENDING', // Base payment still uncollected!
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-cod-supp',
              revision: 1,
              direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
              amountJmd: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );

      settlementServiceMock.getObligationBalance.mockResolvedValueOnce({
        obligationId: 'ob-cod-supp',
        totalAmountJmd: '300.00',
        totalSettledJmd: '300.00',
        remainingBalanceJmd: '0.00',
        isFullySettled: true, // Supplement was discharged
      });

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(false); // Handover strictly blocked because base order COD is uncollected!
    });

    it('TC-WP3.4-REL-18D (Test 11): permits both dispatch and handover for COD full collection with authoritative evidence', async () => {
      // Base order COD payment confirmed with authoritative driver receipt reference, and supplement fully discharged
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.CASH_ON_DELIVERY,
                  status: 'PAID',
                  providerReference: 'COD-RECEIPT-TICKET-78910',
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-cod-supp',
              revision: 1,
              direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
              amountJmd: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );

      settlementServiceMock.getObligationBalance.mockResolvedValueOnce({
        obligationId: 'ob-cod-supp',
        totalAmountJmd: '300.00',
        totalSettledJmd: '300.00',
        remainingBalanceJmd: '0.00',
        isFullySettled: true,
      });

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('PASSED');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(true); // Full collection confirmed!
    });

    it('TC-WP3.4-REL-18E (Test 12): blocks handover under COD partial collection', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockFullAdjustment({
          orderItem: {
            ...createMockFullAdjustment().orderItem,
            vendorOrder: {
              ...createMockFullAdjustment().orderItem.vendorOrder,
              order: {
                ...createMockFullAdjustment().orderItem.vendorOrder.order,
                payment: {
                  provider: PaymentProviderName.CASH_ON_DELIVERY,
                  status: 'PENDING',
                },
              },
            },
          },
          financialObligations: [
            {
              id: 'ob-cod-supp',
              revision: 1,
              direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
              amountJmd: new Prisma.Decimal('500.00'),
            },
          ],
        }),
      );

      settlementServiceMock.getObligationBalance.mockResolvedValueOnce({
        obligationId: 'ob-cod-supp',
        totalAmountJmd: '500.00',
        totalSettledJmd: '250.00',
        remainingBalanceJmd: '250.00',
        isFullySettled: false, // Partial collection!
      });

      const result = await service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-001' });

      expect(result.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(result.dispatchReady).toBe(true);
      expect(result.handoverReady).toBe(false);
    });

    it('TC-WP3.4-REL-19: fails closed with AdjustmentNotFoundError if adjustment does not exist', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.evaluateReleaseReadiness({ weightAdjustmentId: 'adj-missing' }),
      ).rejects.toThrow(AdjustmentNotFoundError);
    });
  });
});
