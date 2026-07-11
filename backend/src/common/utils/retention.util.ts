const RETENTION_YEARS = 7;

// seafood-compliance-rules.md's Data Retention section: traceability,
// inspection, temperature, and recall records must be retained 7 years.
// Informational only - no scheduler exists in this codebase to enforce or
// purge on this date, matching the "captured, not enforced" precedent
// already used for Vendor.complianceScore/Driver.capacityLbs elsewhere.
export function computeRetentionExpiresAt(createdAt: Date): Date {
  const expiresAt = new Date(createdAt);
  expiresAt.setFullYear(expiresAt.getFullYear() + RETENTION_YEARS);
  return expiresAt;
}
