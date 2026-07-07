import { VendorDocumentType, VendorTier } from '@prisma/client';

// Ordinal ranking so upgrade requests can be validated as "strictly higher
// than the vendor's current tier" - not a DB table, since tier ordering is
// a fixed property of the enum itself, not configuration.
export const TIER_RANK: Record<VendorTier, number> = {
  COMMUNITY_FISHER: 1,
  VERIFIED_VENDOR: 2,
  COMMERCIAL_SUPPLIER: 3,
  ENTERPRISE_SUPPLIER: 4,
};

// Which document types must be APPROVED before a vendor at this tier may
// sell, per vendor-tier-rules.md/vendor-classification.md/vendor-onboarding.md's
// "Required" document lists (reconciled onto this codebase's VendorDocumentType
// enum). Not a DB table - vendor-tier-rules.md's own "Database Requirements"
// section doesn't list one, and this mapping only changes when the tier
// system itself is redesigned, unlike the feature flags/limits it explicitly
// asks to be configuration-driven.
//
// Phone Verification/Address/Fishing Area Declaration (Community Fisher) and
// the Food Safety Agreement (all tiers) are not modeled as uploaded
// documents: phone/address are already captured on the Vendor/User profile,
// and the Food Safety Agreement is the existing Vendor.termsAcceptedAt field
// captured at registration - adding duplicate document rows for data the
// platform already records elsewhere would be redundant, not additional
// enforcement. "Audit Compliance" (Enterprise Supplier) is folded into
// REGULATORY_CERTIFICATION rather than introducing a single-purpose enum
// value for one deferred concept.
export const REQUIRED_DOCUMENTS_BY_TIER: Record<VendorTier, VendorDocumentType[]> = {
  COMMUNITY_FISHER: ['GOVERNMENT_ID'],
  VERIFIED_VENDOR: ['GOVERNMENT_ID', 'BUSINESS_REGISTRATION'],
  COMMERCIAL_SUPPLIER: [
    'BUSINESS_REGISTRATION',
    'TAX_COMPLIANCE_CERTIFICATE',
    'INSURANCE_CERTIFICATE',
    'FOOD_SAFETY_DOCUMENTATION',
  ],
  ENTERPRISE_SUPPLIER: [
    'BUSINESS_REGISTRATION',
    'TAX_COMPLIANCE_CERTIFICATE',
    'INSURANCE_CERTIFICATE',
    'FOOD_SAFETY_DOCUMENTATION',
    'REGULATORY_CERTIFICATION',
  ],
};
