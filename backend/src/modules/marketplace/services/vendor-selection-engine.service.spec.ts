import { VendorCandidate, VendorSelectionEngineService, VendorSelectionWeights } from './vendor-selection-engine.service';

function buildCandidate(overrides: Partial<VendorCandidate> = {}): VendorCandidate {
  return {
    vendorId: 'vendor-1',
    productId: 'product-1',
    vendorStatus: 'APPROVED',
    vendorParish: 'KINGSTON',
    vendorComplianceScore: null,
    productIsActive: true,
    quantityAvailable: 20,
    lotFoodSafetyStatus: 'SAFE',
    lotFreshnessGrade: null,
    ...overrides,
  };
}

const weights: VendorSelectionWeights = {
  inventoryWeight: 0.3,
  freshnessWeight: 0.2,
  complianceWeight: 0.2,
  distanceWeight: 0.15,
  ratingWeight: 0.05,
  deliveryCapacityWeight: 0.1,
};

describe('VendorSelectionEngineService', () => {
  let engine: VendorSelectionEngineService;

  beforeEach(() => {
    engine = new VendorSelectionEngineService();
  });

  describe('eligibility', () => {
    it('marks a vendor ineligible when not approved', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ vendorStatus: 'PENDING' }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibilityReason).toBe('Vendor is not approved');
      expect(result.totalScore).toBe(0);
    });

    it('marks a vendor ineligible when the product is inactive', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ productIsActive: false }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibilityReason).toBe('Product is not active');
    });

    it('marks a vendor ineligible when inventory is insufficient', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ quantityAvailable: 5 }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibilityReason).toBe('Insufficient inventory to fulfill the requested quantity');
    });

    it('marks a vendor ineligible when the lot is not SAFE', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ lotFoodSafetyStatus: 'QUARANTINED' }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.eligible).toBe(false);
      expect(result.ineligibilityReason).toBe('Product is not currently cleared for sale');
    });

    it('is eligible when a product has no lot at all', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ lotFoodSafetyStatus: null }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.eligible).toBe(true);
    });
  });

  describe('scoring', () => {
    it('caps inventory score at 100 when supply well exceeds demand', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ quantityAvailable: 1000 }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.inventoryScore).toBe(100);
    });

    it('scores inventory proportionally when supply just meets demand', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ quantityAvailable: 10 }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.inventoryScore).toBe(100);
    });

    it('uses the freshness grade when a lot is present', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ lotFreshnessGrade: 'GRADE_A' }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.freshnessScore).toBe(100);
    });

    it('uses a neutral freshness score when there is no lot', () => {
      const result = engine.scoreCandidate(buildCandidate(), 10, 'KINGSTON', weights);
      expect(result.freshnessScore).toBe(50);
    });

    it('uses the vendor compliance score when present', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ vendorComplianceScore: 90 }),
        10,
        'KINGSTON',
        weights,
      );
      expect(result.complianceScore).toBe(90);
    });

    it('uses a neutral compliance score when not yet computed', () => {
      const result = engine.scoreCandidate(buildCandidate(), 10, 'KINGSTON', weights);
      expect(result.complianceScore).toBe(50);
    });

    it('scores same-parish vendors higher than out-of-parish vendors', () => {
      const sameParish = engine.scoreCandidate(
        buildCandidate({ vendorParish: 'KINGSTON' }),
        10,
        'KINGSTON',
        weights,
      );
      const otherParish = engine.scoreCandidate(
        buildCandidate({ vendorParish: 'ST_ANN' }),
        10,
        'KINGSTON',
        weights,
      );
      expect(sameParish.distanceScore).toBeGreaterThan(otherParish.distanceScore);
    });

    it('always uses neutral rating and delivery capacity scores', () => {
      const result = engine.scoreCandidate(buildCandidate(), 10, 'KINGSTON', weights);
      expect(result.ratingScore).toBe(50);
      expect(result.deliveryCapacityScore).toBe(50);
    });

    it('computes totalScore as the weighted sum of all factors', () => {
      const result = engine.scoreCandidate(
        buildCandidate({ quantityAvailable: 10, lotFreshnessGrade: 'GRADE_A', vendorComplianceScore: 80 }),
        10,
        'KINGSTON',
        weights,
      );
      const expected = 100 * 0.3 + 100 * 0.2 + 80 * 0.2 + 100 * 0.15 + 50 * 0.05 + 50 * 0.1;
      expect(result.totalScore).toBeCloseTo(expected, 5);
    });
  });

  describe('pickWinner', () => {
    it('returns null when no candidate is eligible', () => {
      const winner = engine.pickWinner([
        engine.scoreCandidate(buildCandidate({ vendorStatus: 'PENDING' }), 10, 'KINGSTON', weights),
      ]);
      expect(winner).toBeNull();
    });

    it('returns the eligible candidate with the highest total score', () => {
      const low = engine.scoreCandidate(
        buildCandidate({ vendorId: 'vendor-low', vendorComplianceScore: 20 }),
        10,
        'KINGSTON',
        weights,
      );
      const high = engine.scoreCandidate(
        buildCandidate({ vendorId: 'vendor-high', vendorComplianceScore: 95 }),
        10,
        'KINGSTON',
        weights,
      );
      const winner = engine.pickWinner([low, high]);
      expect(winner?.vendorId).toBe('vendor-high');
    });

    it('breaks ties deterministically by vendorId', () => {
      const a = engine.scoreCandidate(buildCandidate({ vendorId: 'vendor-a' }), 10, 'KINGSTON', weights);
      const z = engine.scoreCandidate(buildCandidate({ vendorId: 'vendor-z' }), 10, 'KINGSTON', weights);
      const winner = engine.pickWinner([z, a]);
      expect(winner?.vendorId).toBe('vendor-a');
    });

    it('ignores ineligible candidates even if they would otherwise score higher', () => {
      const ineligible = engine.scoreCandidate(
        buildCandidate({ vendorId: 'vendor-ineligible', vendorStatus: 'SUSPENDED' }),
        10,
        'KINGSTON',
        weights,
      );
      const eligible = engine.scoreCandidate(
        buildCandidate({ vendorId: 'vendor-eligible' }),
        10,
        'KINGSTON',
        weights,
      );
      const winner = engine.pickWinner([ineligible, eligible]);
      expect(winner?.vendorId).toBe('vendor-eligible');
    });
  });
});
