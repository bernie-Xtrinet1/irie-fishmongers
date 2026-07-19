// Pure scoring functions for the 10A Fleet Dispatch Engine - kept free of
// any repository/Prisma dependency so they're trivially unit-testable.
// Eligibility (zone match, availability, cold-chain requirement, current
// load) is enforced as a hard filter in the repository candidate queries
// (DriversRepository.findDispatchCandidates /
// FleetAssetsRepository.findDispatchCandidates), not scored here - only
// capacity is both a hard eligibility check (isCapacityEligible) and a
// soft ranking signal (computeCapacityFitScore) among already-eligible
// candidates, since "insufficient capacity" and "capacity is a poor fit"
// are different questions.

// null capacityLbs is treated as unlimited (most seeded drivers have no
// capacity set - excluding them all would starve the candidate pool), per
// the explicit Phase 12B.0 scope decision.
export function isCapacityEligible(capacityLbs: number | null, totalWeightLbs: number): boolean {
  if (capacityLbs === null) {
    return true;
  }
  return capacityLbs >= totalWeightLbs;
}

// Higher score = tighter fit (less wasted capacity), 0-100. A vehicle with
// unknown (null) capacity, or a run with no known weight requirement,
// scores as a neutral 50 rather than a false "perfect fit" - we genuinely
// don't know, so the score shouldn't claim otherwise.
export function computeCapacityFitScore(capacityLbs: number | null, totalWeightLbs: number): number {
  if (capacityLbs === null || totalWeightLbs <= 0) {
    return 50;
  }
  if (capacityLbs <= 0) {
    return 0;
  }
  const utilization = Math.min(1, totalWeightLbs / capacityLbs);
  return Math.round(utilization * 100);
}
