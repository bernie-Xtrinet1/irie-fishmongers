import { VendorComplianceStatusLabel } from '../entities/vendor-profile-response.entity';

const COMPLIANT_THRESHOLD = 80;
const AT_RISK_THRESHOLD = 50;

// Shared by VendorProfileService and ProductsService (Product Detail Page's
// Vendor Information section) so the compliance-score-to-status mapping is
// defined exactly once, per CLAUDE.md's "never duplicate business logic".
export function deriveVendorComplianceStatus(score: number | null): VendorComplianceStatusLabel {
  if (score === null) {
    return VendorComplianceStatusLabel.NOT_YET_ASSESSED;
  }
  if (score >= COMPLIANT_THRESHOLD) {
    return VendorComplianceStatusLabel.COMPLIANT;
  }
  if (score >= AT_RISK_THRESHOLD) {
    return VendorComplianceStatusLabel.AT_RISK;
  }
  return VendorComplianceStatusLabel.NON_COMPLIANT;
}
