import { computeCapacityFitScore, isCapacityEligible } from './dispatch-scoring.util';

describe('isCapacityEligible', () => {
  it('treats null capacity as unlimited (always eligible)', () => {
    expect(isCapacityEligible(null, 500)).toBe(true);
  });

  it('is eligible when capacity meets or exceeds the required weight', () => {
    expect(isCapacityEligible(100, 100)).toBe(true);
    expect(isCapacityEligible(150, 100)).toBe(true);
  });

  it('is ineligible when capacity is below the required weight', () => {
    expect(isCapacityEligible(99, 100)).toBe(false);
  });
});

describe('computeCapacityFitScore', () => {
  it('scores a neutral 50 when capacity is unknown (null)', () => {
    expect(computeCapacityFitScore(null, 100)).toBe(50);
  });

  it('scores a neutral 50 when the run has no known weight requirement', () => {
    expect(computeCapacityFitScore(200, 0)).toBe(50);
  });

  it('scores 100 for a perfectly tight fit', () => {
    expect(computeCapacityFitScore(100, 100)).toBe(100);
  });

  it('scores lower for a more oversized vehicle', () => {
    const tight = computeCapacityFitScore(110, 100);
    const loose = computeCapacityFitScore(1000, 100);
    expect(tight).toBeGreaterThan(loose);
  });

  it('clamps at 0 for a non-positive capacity', () => {
    expect(computeCapacityFitScore(0, 100)).toBe(0);
  });
});
