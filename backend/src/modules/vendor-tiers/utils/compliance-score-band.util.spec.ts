import { ComplianceBand, deriveComplianceBand } from './compliance-score-band.util';

describe('deriveComplianceBand', () => {
  it('maps null to NOT_YET_ASSESSED (never the lowest band)', () => {
    expect(deriveComplianceBand(null)).toBe(ComplianceBand.NOT_YET_ASSESSED);
  });

  it.each([
    [100, ComplianceBand.EXCELLENT],
    [90, ComplianceBand.EXCELLENT],
    [89, ComplianceBand.GOOD],
    [75, ComplianceBand.GOOD],
    [74, ComplianceBand.FAIR],
    [60, ComplianceBand.FAIR],
    [59, ComplianceBand.NEEDS_IMPROVEMENT],
    [0, ComplianceBand.NEEDS_IMPROVEMENT],
  ])('maps a score of %i to %s', (score, band) => {
    expect(deriveComplianceBand(score)).toBe(band);
  });
});
