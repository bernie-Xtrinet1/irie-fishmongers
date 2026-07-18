// Customer-facing compliance bands (Phase 13C/13E). Deliberately SEPARATE
// from deriveVendorComplianceStatus (COMPLIANT/AT_RISK/NON_COMPLIANT at
// 80/50) - that mapping serves internal risk classification; this one is
// the wording shown to shoppers on the vendor profile and product pages.
//
// The wording is chosen so a low score never implies a formal enforcement
// action: "Needs Improvement" describes the score honestly, whereas
// "Restricted"/"Under Review" would imply a Vendor.status the vendor may
// not actually have. A null score is its own explicit state and must never
// be coerced into the lowest band.

export enum ComplianceBand {
  EXCELLENT = 'EXCELLENT',
  GOOD = 'GOOD',
  FAIR = 'FAIR',
  NEEDS_IMPROVEMENT = 'NEEDS_IMPROVEMENT',
  NOT_YET_ASSESSED = 'NOT_YET_ASSESSED',
}

const EXCELLENT_THRESHOLD = 90;
const GOOD_THRESHOLD = 75;
const FAIR_THRESHOLD = 60;

export function deriveComplianceBand(score: number | null): ComplianceBand {
  if (score === null) {
    return ComplianceBand.NOT_YET_ASSESSED;
  }
  if (score >= EXCELLENT_THRESHOLD) {
    return ComplianceBand.EXCELLENT;
  }
  if (score >= GOOD_THRESHOLD) {
    return ComplianceBand.GOOD;
  }
  if (score >= FAIR_THRESHOLD) {
    return ComplianceBand.FAIR;
  }
  return ComplianceBand.NEEDS_IMPROVEMENT;
}
