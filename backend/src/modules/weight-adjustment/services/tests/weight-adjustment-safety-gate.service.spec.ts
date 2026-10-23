import {
  FoodSafetyStatus,
  FreshnessGrade,
  InspectionResult,
  Prisma,
  RecallSeverityClass,
  RegulatoryStatus,
  VendorStatus,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import {
  ColdChainBreachError,
  FoodSafetyIncidentActiveError,
  ProvenanceMismatchError,
  QualityInspectionFailedError,
  SeafoodListingExpiredError,
  SeafoodLotRecalledError,
  SeafoodSafetyHoldError,
  UnlinkedSeafoodLotError,
  VendorNotEligibleError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { SafetyGateEvaluationContext } from '../types/weight-adjustment-safety.types';
import { WeightAdjustmentSafetyGateService } from '../weight-adjustment-safety-gate.service';

/**
 * Phase 16D WP3.2: Weight Adjustment Food Safety Gate Service Unit Tests
 *
 * Verifies multi-record corroboration across:
 * - Unlinked seafood lot failure
 * - False-positive default SAFE status with active recalls
 * - Cold-chain breaches (unresolved CRITICAL / EMERGENCY alerts)
 * - Non-critical temperature alerts (warnings without blocking)
 * - Open/investigating high/critical food safety incidents
 * - Quality inspections (REJECTED, QUARANTINED, CONDITIONAL, RESTRICTED species)
 * - Traceable provenance (listing-lot and vendor matching)
 * - Listing expiration and expiring-soon warnings
 * - Future catch dates
 * - Transaction propagation
 */
describe('WeightAdjustmentSafetyGateService', () => {
  let service: WeightAdjustmentSafetyGateService;
  let prismaMock: any;

  const validLotId = 'lot-abc-123';
  const validVendorId = 'vendor-v-1';
  const validListingId = 'listing-dl-1';
  const now = new Date('2026-10-21T12:00:00.000Z');

  const createMockLot = (overrides: any = {}) => ({
    id: validLotId,
    vendorId: validVendorId,
    foodSafetyStatus: FoodSafetyStatus.SAFE,
    freshnessGrade: FreshnessGrade.GRADE_A,
    qualityScore: 92,
    catchDate: new Date(now.getTime() - 24 * 60 * 60 * 1000), // 1 day before evaluation time
    vendor: {
      id: validVendorId,
      status: VendorStatus.APPROVED,
    },
    speciesRef: {
      id: 'species-snapper',
      regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
    },
    recallLots: [],
    temperatureAlerts: [],
    incidents: [],
    inspections: [
      {
        id: 'insp-1',
        result: InspectionResult.PASSED,
        freshnessGrade: FreshnessGrade.GRADE_A,
        qualityScore: 95,
        inspectedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      },
    ],
    ...overrides,
  });

  const createMockListing = (overrides: any = {}) => ({
    id: validListingId,
    lotId: validLotId,
    vendorId: validVendorId,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from current test run
    status: 'ACTIVE',
    ...overrides,
  });

  beforeEach(() => {
    prismaMock = {
      seafoodLot: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockLot())),
      },
      vendorDailyListing: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(createMockListing())),
      },
      vendorProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: validVendorId, status: VendorStatus.APPROVED }),
      },
    };

    service = new WeightAdjustmentSafetyGateService(prismaMock as unknown as PrismaService);
  });

  describe('Scenario 1: Lot not found', () => {
    it('evaluates lot as ineligible with UNLINKED_SEAFOOD_LOT reason', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue(null);

      const result = await service.evaluateLotSafety({
        seafoodLotId: 'non-existent-lot',
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toEqual(['UNLINKED_SEAFOOD_LOT']);
    });

    it('assertLotSafeForFulfillment throws UnlinkedSeafoodLotError', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue(null);

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: 'non-existent-lot',
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(UnlinkedSeafoodLotError);
    });
  });

  describe('Scenario 2: Default SAFE in DB with active or investigating recall', () => {
    it('blocks fulfillment when recall status is ACTIVE', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        foodSafetyStatus: FoodSafetyStatus.SAFE, // default safe in DB
        recallLots: [
          {
            recall: {
              id: 'recall-1',
              status: 'ACTIVE',
              reason: 'Ciguatera toxin suspected',
              severityClass: RecallSeverityClass.CLASS_I,
            },
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('LOT_UNDER_ACTIVE_RECALL');
    });

    it('blocks fulfillment when recall status is INVESTIGATING', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        foodSafetyStatus: FoodSafetyStatus.SAFE,
        recallLots: [
          {
            recall: {
              id: 'recall-2',
              status: 'INVESTIGATING',
              reason: 'Temperature abuse in transit',
              severityClass: RecallSeverityClass.CLASS_II,
            },
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('LOT_UNDER_ACTIVE_RECALL');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(SeafoodLotRecalledError);
    });

    it('blocks fulfillment when lot status itself is RECALLED', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        foodSafetyStatus: FoodSafetyStatus.RECALLED,
        recallLots: [],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('SEAFOOD_LOT_NOT_SAFE');
      expect(result.blockingReasons).toContain('LOT_UNDER_ACTIVE_RECALL');
    });
  });

  describe('Scenario 3: Cold-chain breach (unresolved CRITICAL or EMERGENCY alert)', () => {
    it('blocks fulfillment on unresolved CRITICAL alert and throws ColdChainBreachError', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        temperatureAlerts: [
          {
            id: 'temp-alert-crit',
            resolved: false,
            severity: 'CRITICAL',
            tempCelsius: 9.5,
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('UNRESOLVED_CRITICAL_TEMPERATURE_ALERT');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(ColdChainBreachError);
    });

    it('blocks fulfillment on unresolved EMERGENCY alert', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        temperatureAlerts: [
          {
            id: 'temp-alert-emg',
            resolved: false,
            severity: 'EMERGENCY',
            tempCelsius: 14.2,
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('UNRESOLVED_CRITICAL_TEMPERATURE_ALERT');
    });

    it('passes if temperature alert is resolved', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        temperatureAlerts: [
          {
            id: 'temp-alert-resolved',
            resolved: true,
            severity: 'CRITICAL',
            tempCelsius: 8.0,
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
    });
  });

  describe('Scenario 4: Unresolved non-critical temperature warning', () => {
    it('produces warning without blocking fulfillment', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        temperatureAlerts: [
          {
            id: 'temp-alert-warn',
            resolved: false,
            severity: 'WARNING',
            tempCelsius: 4.8,
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.warnings).toContain('NON_CRITICAL_TEMPERATURE_WARNING');

      // assertLotSafeForFulfillment should not throw
      const assertResult = await service.assertLotSafeForFulfillment({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });
      expect(assertResult.eligible).toBe(true);
    });
  });

  describe('Scenario 5: Open serious food safety incident', () => {
    it('blocks on OPEN HIGH incident and throws FoodSafetyIncidentActiveError', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        incidents: [
          {
            id: 'inc-1',
            status: 'OPEN',
            severity: 'HIGH',
            description: 'Histamine test failure reported by port inspector',
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('UNRESOLVED_CRITICAL_SAFETY_INCIDENT');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(FoodSafetyIncidentActiveError);
    });

    it('blocks on INVESTIGATING CRITICAL incident', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        incidents: [
          {
            id: 'inc-2',
            status: 'INVESTIGATING',
            severity: 'CRITICAL',
            description: 'Cross-contamination suspected',
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('UNRESOLVED_CRITICAL_SAFETY_INCIDENT');
    });

    it('ignores CLOSED incident with high severity', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        incidents: [
          {
            id: 'inc-3',
            status: 'RESOLVED',
            severity: 'CRITICAL',
            description: 'False alarm cleared by re-test',
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
    });
  });

  describe('Scenario 6: Quality inspection REJECTED or QUARANTINED', () => {
    it('blocks on REJECTED inspection and throws QualityInspectionFailedError', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        inspections: [
          {
            id: 'insp-rej',
            result: InspectionResult.REJECTED,
            inspectedAt: new Date('2026-10-21T09:00:00.000Z'),
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('BLOCKING_QUALITY_INSPECTION');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(QualityInspectionFailedError);
    });

    it('blocks on QUARANTINED inspection', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        inspections: [
          {
            id: 'insp-quar',
            result: InspectionResult.QUARANTINED,
            inspectedAt: new Date('2026-10-21T09:00:00.000Z'),
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('BLOCKING_QUALITY_INSPECTION');
    });
  });

  describe('Scenario 7: CONDITIONAL inspection result', () => {
    it('blocks rather than passing when inspection result is CONDITIONAL', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        inspections: [
          {
            id: 'insp-cond',
            result: InspectionResult.CONDITIONAL,
            inspectedAt: new Date('2026-10-21T09:00:00.000Z'),
          },
        ],
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('CONDITIONAL_INSPECTION_UNRESOLVED');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(QualityInspectionFailedError);
    });
  });

  describe('Scenario 8 & 9: Restricted species and optional inspections', () => {
    it('Scenario 8: blocks restricted species missing mandatory inspection', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        speciesRef: {
          id: 'species-restricted-conch',
          regulatoryStatus: RegulatoryStatus.RESTRICTED,
        },
        inspections: [], // missing inspection
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('MANDATORY_INSPECTION_MISSING');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(QualityInspectionFailedError);
    });

    it('Scenario 9: passes non-restricted species with missing optional inspection', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        speciesRef: {
          id: 'species-snapper',
          regulatoryStatus: RegulatoryStatus.UNRESTRICTED, // non-restricted
        },
        inspections: [], // optional inspection absent
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
    });
  });

  describe('Scenario 10: Listing-to-lot provenance mismatch', () => {
    it('blocks and throws ProvenanceMismatchError when listing.lotId does not match lot.id', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue({
        ...createMockListing(),
        lotId: 'different-lot-id',
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('LISTING_LOT_PROVENANCE_MISMATCH');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
          vendorDailyListingId: validListingId,
        }),
      ).rejects.toThrow(ProvenanceMismatchError);
    });

    it('blocks if listing record is missing entirely when vendorDailyListingId supplied', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue(null);

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: 'missing-listing-id',
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('LISTING_LOT_PROVENANCE_MISMATCH');
    });
  });

  describe('Scenario 11 & 12: Vendor provenance and vendor status', () => {
    it('Scenario 11: blocks when listing vendor differs from lot vendor or order seller', async () => {
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue({
        ...createMockListing(),
        vendorId: 'other-vendor-456',
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('VENDOR_PROVENANCE_MISMATCH');
    });

    it('Scenario 12: blocks when vendor status is SUSPENDED or not APPROVED', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        vendor: {
          id: validVendorId,
          status: VendorStatus.SUSPENDED,
        },
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('VENDOR_NOT_IN_GOOD_STANDING');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(VendorNotEligibleError);
    });
  });

  describe('Scenario 13: Listing expiration and warning threshold', () => {
    it('blocks and throws SeafoodListingExpiredError when listing is expired', async () => {
      const evaluationTime = new Date('2026-10-21T14:00:00.000Z');
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue({
        ...createMockListing(),
        expiresAt: new Date('2026-10-21T13:00:00.000Z'), // expired 1 hour ago
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
        atDate: evaluationTime,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('LISTING_EXPIRED');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
          vendorDailyListingId: validListingId,
          atDate: evaluationTime,
        }),
      ).rejects.toThrow(SeafoodListingExpiredError);
    });

    it('emits LISTING_EXPIRING_SOON warning if listing expires within 2 hours', async () => {
      const evaluationTime = new Date('2026-10-21T12:00:00.000Z');
      prismaMock.vendorDailyListing.findUnique.mockResolvedValue({
        ...createMockListing(),
        expiresAt: new Date('2026-10-21T13:30:00.000Z'), // expires in 90 minutes
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
        atDate: evaluationTime,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.warnings).toContain('LISTING_EXPIRING_SOON');
    });
  });

  describe('Scenario 14: Catch date in the future', () => {
    it('blocks fulfillment when catch date is in the future beyond clock skew', async () => {
      const evaluationTime = new Date('2026-10-21T12:00:00.000Z');
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot(),
        catchDate: new Date('2026-10-22T00:00:00.000Z'), // tomorrow
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        atDate: evaluationTime,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('CATCH_DATE_INVALID');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
          atDate: evaluationTime,
        }),
      ).rejects.toThrow(SeafoodSafetyHoldError);
    });
  });

  describe('Scenario 15: Fully eligible lot passing all gates', () => {
    it('returns eligible: true with zero blocking reasons and records inspection metrics', async () => {
      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.lotStatus).toBe(FoodSafetyStatus.SAFE);
      expect(result.freshnessGrade).toBe(FreshnessGrade.GRADE_A);
      expect(result.qualityScore).toBe(92);

      const asserted = await service.assertLotSafeForFulfillment({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        vendorDailyListingId: validListingId,
      });
      expect(asserted.eligible).toBe(true);
    });
  });

  describe('Scenario 16: Transaction propagation', () => {
    it('uses provided Prisma transaction client instead of root prisma service', async () => {
      const txMock: any = {
        seafoodLot: {
          findUnique: jest.fn().mockResolvedValue(createMockLot()),
        },
        vendorDailyListing: {
          findUnique: jest.fn().mockResolvedValue(createMockListing()),
        },
      };

      await service.evaluateLotSafety(
        {
          seafoodLotId: validLotId,
          vendorId: validVendorId,
          vendorDailyListingId: validListingId,
        },
        txMock as Prisma.TransactionClient,
      );

      expect(txMock.seafoodLot.findUnique).toHaveBeenCalled();
      expect(txMock.vendorDailyListing.findUnique).toHaveBeenCalled();
      expect(prismaMock.seafoodLot.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 17: LOT-A with SAFETY_HOLD status', () => {
    it('blocks fulfillment and throws SeafoodSafetyHoldError when lot foodSafetyStatus is not SAFE', async () => {
      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot({
          foodSafetyStatus: FoodSafetyStatus.SAFETY_HOLD,
        }),
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
      });

      expect(result.eligible).toBe(false);
      expect(result.blockingReasons).toContain('SEAFOOD_LOT_NOT_SAFE');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow(SeafoodSafetyHoldError);
    });
  });

  describe('Scenario 18: Older catch dates (e.g. frozen or shelf-stable inventory) are not rejected by arbitrary 14-day threshold', () => {
    it('does not reject older catch date under blanket 14-day shelf-life rule', async () => {
      const evaluationTime = new Date('2026-10-21T12:00:00.000Z');
      const olderCatchDate = new Date('2026-10-01T08:00:00.000Z'); // 20 days ago

      prismaMock.seafoodLot.findUnique.mockResolvedValue({
        ...createMockLot({
          catchDate: olderCatchDate,
        }),
      });

      const result = await service.evaluateLotSafety({
        seafoodLotId: validLotId,
        vendorId: validVendorId,
        atDate: evaluationTime,
      });

      expect(result.eligible).toBe(true);
      expect(result.blockingReasons).not.toContain('CATCH_DATE_INVALID');
    });
  });

  describe('Scenario 19: Database errors during safety evaluation fail closed', () => {
    it('bubbles database failure and fails closed without marking lot eligible', async () => {
      prismaMock.seafoodLot.findUnique.mockRejectedValue(
        new Error('PostgreSQL connection timeout: connection pool exhausted'),
      );

      await expect(
        service.evaluateLotSafety({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow('PostgreSQL connection timeout');

      await expect(
        service.assertLotSafeForFulfillment({
          seafoodLotId: validLotId,
          vendorId: validVendorId,
        }),
      ).rejects.toThrow('PostgreSQL connection timeout');
    });
  });
});
