import { ComplianceSignals, computeComplianceScore } from './compliance-score-formula.util';

function signals(overrides: Partial<ComplianceSignals> = {}): ComplianceSignals {
  return {
    temperatureAlerts: { warning: 0, critical: 0, emergency: 0 },
    inspections: { rejected: 0, quarantined: 0, conditional: 0 },
    activeRecalls: 0,
    certifications: { expired: 0, requiresCertifications: false, hasActiveCertification: false },
    ...overrides,
  };
}

describe('computeComplianceScore', () => {
  it('gives a clean-slate vendor the full 100 with no deductions', () => {
    const result = computeComplianceScore(signals());
    expect(result).toEqual({
      score: 100,
      temperatureDeduction: 0,
      inspectionDeduction: 0,
      recallDeduction: 0,
      certificationDeduction: 0,
    });
  });

  describe('temperature alerts', () => {
    it('deducts per severity', () => {
      const result = computeComplianceScore(
        signals({ temperatureAlerts: { warning: 1, critical: 1, emergency: 1 } }),
      );
      // 2 + 5 + 10 = 17
      expect(result.temperatureDeduction).toBe(17);
      expect(result.score).toBe(83);
    });

    it('caps each severity independently', () => {
      const result = computeComplianceScore(
        signals({ temperatureAlerts: { warning: 100, critical: 100, emergency: 100 } }),
      );
      // capped 10 + 20 + 30 = 60
      expect(result.temperatureDeduction).toBe(60);
      expect(result.score).toBe(40);
    });
  });

  describe('inspections', () => {
    it('deducts per failing result under the combined cap', () => {
      const result = computeComplianceScore(
        signals({ inspections: { rejected: 1, quarantined: 1, conditional: 1 } }),
      );
      // 8 + 6 + 2 = 16
      expect(result.inspectionDeduction).toBe(16);
    });

    it('applies a single combined cap of 25', () => {
      const result = computeComplianceScore(
        signals({ inspections: { rejected: 10, quarantined: 10, conditional: 10 } }),
      );
      expect(result.inspectionDeduction).toBe(25);
    });
  });

  describe('recalls', () => {
    it('deducts 20 per active recall', () => {
      expect(computeComplianceScore(signals({ activeRecalls: 1 })).recallDeduction).toBe(20);
    });

    it('caps recall deduction at 40', () => {
      expect(computeComplianceScore(signals({ activeRecalls: 5 })).recallDeduction).toBe(40);
    });
  });

  describe('certifications', () => {
    it('deducts per expired cert, capped at 20', () => {
      expect(
        computeComplianceScore(signals({ certifications: { expired: 5, requiresCertifications: false, hasActiveCertification: false } }))
          .certificationDeduction,
      ).toBe(20);
    });

    it('adds a flat 15 when the tier requires a cert and none is active', () => {
      const result = computeComplianceScore(
        signals({ certifications: { expired: 0, requiresCertifications: true, hasActiveCertification: false } }),
      );
      expect(result.certificationDeduction).toBe(15);
    });

    it('does not add the flat hit when the required cert is active', () => {
      const result = computeComplianceScore(
        signals({ certifications: { expired: 0, requiresCertifications: true, hasActiveCertification: true } }),
      );
      expect(result.certificationDeduction).toBe(0);
    });
  });

  it('floors the score at 0 when deductions exceed the baseline', () => {
    const result = computeComplianceScore(
      signals({
        temperatureAlerts: { warning: 100, critical: 100, emergency: 100 }, // 60
        inspections: { rejected: 100, quarantined: 0, conditional: 0 }, // 25
        activeRecalls: 100, // 40
        certifications: { expired: 100, requiresCertifications: true, hasActiveCertification: false }, // 35
      }),
    );
    // 60 + 25 + 40 + 35 = 160 deductions -> clamped to 0, never negative
    expect(result.score).toBe(0);
  });
});
