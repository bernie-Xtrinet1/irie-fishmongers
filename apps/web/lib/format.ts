import { ComplianceBand } from '@iriefishmongers/types';

// Converts a SCREAMING_SNAKE_CASE enum value (Parish, VendorComplianceStatusLabel,
// FreshnessGrade, ...) into readable Title Case, e.g. "ST_ANDREW" -> "St Andrew".
export function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

export function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-JM', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Customer-facing compliance band wording (Phase 13E). "Needs Improvement"
// deliberately avoids implying a formal enforcement action (that is
// Vendor.status, shown separately). Null score -> "Not yet assessed".
const COMPLIANCE_BAND_LABELS: Record<ComplianceBand, string> = {
  [ComplianceBand.EXCELLENT]: 'Excellent',
  [ComplianceBand.GOOD]: 'Good',
  [ComplianceBand.FAIR]: 'Fair',
  [ComplianceBand.NEEDS_IMPROVEMENT]: 'Needs Improvement',
  [ComplianceBand.NOT_YET_ASSESSED]: 'Not yet assessed',
};

export function formatComplianceBand(band: ComplianceBand): string {
  return COMPLIANCE_BAND_LABELS[band];
}

// Coarse "x ago" for compliance freshness and review dates. Returns null for
// a missing timestamp so callers can omit the clause rather than render a
// broken value.
export function formatRelativeTime(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

const DEMO_SAMPLE_PHOTO_PREFIX = '/demo-products/';

/**
 * Returns true when an image reference points to a bundled `/demo-products/*`
 * asset so storefront and vendor UIs label it clearly as a sample demo photo.
 */
export function isDemoSamplePhotoUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith(DEMO_SAMPLE_PHOTO_PREFIX)) {
    return true;
  }
  try {
    return new URL(trimmed).pathname.startsWith(DEMO_SAMPLE_PHOTO_PREFIX);
  } catch {
    return false;
  }
}
