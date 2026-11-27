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
const CATALOGUE_PHOTO_PREFIX = '/catalogue-photos/';

export interface DemoSamplePhotoCredit {
  assetPath: string;
  title: string;
  author: string;
  sourceLabel: string;
  sourceUrl: string;
  licenseName: string;
  licenseUrl: string;
  modifications: string;
  requiresAttribution: boolean;
}

const DEMO_SAMPLE_PHOTO_CREDITS: Record<string, DemoSamplePhotoCredit> = {
  '/demo-products/red-snapper.png': {
    assetPath: '/demo-products/red-snapper.png',
    title: 'Red Snapper',
    author: 'Garitzko',
    sourceLabel: 'File:Lutjanus_campechanus_on_ice.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Lutjanus_campechanus_on_ice.jpg',
    licenseName: 'Public Domain (PD-self)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG; added SAMPLE PHOTO · DEMO badge',
    requiresAttribution: false,
  },
  '/demo-products/jumbo-shrimp.png': {
    assetPath: '/demo-products/jumbo-shrimp.png',
    title: 'Jumbo Shrimp',
    author: 'Tamorlan',
    sourceLabel: 'File:Penaeus_esculentus-2009.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Penaeus_esculentus-2009.jpg',
    licenseName: 'CC BY 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    modifications: 'Resized/cropped to 900x600 PNG; added SAMPLE PHOTO · DEMO badge',
    requiresAttribution: true,
  },
  '/demo-products/lobster.png': {
    assetPath: '/demo-products/lobster.png',
    title: 'Fresh Lobster',
    author: 'SEFSC Pascagoula Laboratory; Collection of Brandi Noble, NOAA/NMFS/SEFSC',
    sourceLabel: 'File:Panulirus_argus_NOAA.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Panulirus_argus_NOAA.jpg',
    licenseName: 'Public Domain (PD-USGov-NOAA)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG; added SAMPLE PHOTO · DEMO badge',
    requiresAttribution: false,
  },
  '/demo-products/king-fish.png': {
    assetPath: '/demo-products/king-fish.png',
    title: 'King Fish',
    author: "NOAA's Fisheries Collection, SEFSC Pascagoula Laboratory; Collection of Brandi Noble, NOAA/NMFS/SEFSC",
    sourceLabel: 'File:King_mackerel_(_Scomberomorus_cavalla_).jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:King_mackerel_(_Scomberomorus_cavalla_).jpg',
    licenseName: 'Public Domain (PD-USGov-NOAA)',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    modifications: 'Resized/cropped to 900x600 PNG; added SAMPLE PHOTO · DEMO badge',
    requiresAttribution: false,
  },
  '/demo-products/mackerel.png': {
    assetPath: '/demo-products/mackerel.png',
    title: 'Mackerel',
    author: 'Fumikas Sagisavas',
    sourceLabel: 'File:Frozen_fresh_mackerel.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Frozen_fresh_mackerel.jpg',
    licenseName: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    modifications: 'Cropped/resized to 900x600 PNG; added SAMPLE PHOTO · DEMO badge',
    requiresAttribution: false,
  },
};

export const DEMO_SAMPLE_PHOTO_CREDITS_LIST: ReadonlyArray<DemoSamplePhotoCredit> =
  Object.values(DEMO_SAMPLE_PHOTO_CREDITS);

export const DEMO_SHRIMP_SAMPLE_CREDIT =
  DEMO_SAMPLE_PHOTO_CREDITS['/demo-products/jumbo-shrimp.png']!;

export type ProductImageBadgeKind = 'SAMPLE_DEMO' | 'CATALOGUE_REFERENCE' | null;

function extractPrefixedAssetPath(
  url: string | null | undefined,
  prefix: string,
): string | null {
  if (!url) {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.startsWith(prefix)) {
    return trimmed;
  }
  try {
    const pathname = new URL(trimmed).pathname;
    return pathname.startsWith(prefix) ? pathname : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when an image reference points to a bundled `/demo-products/*`
 * asset so storefront and vendor UIs label it clearly as a sample demo photo.
 */
export function isDemoSamplePhotoUrl(url: string | null | undefined): boolean {
  return extractPrefixedAssetPath(url, DEMO_SAMPLE_PHOTO_PREFIX) !== null;
}

/**
 * Returns true when an image reference points to a bundled `/catalogue-photos/*`
 * species reference asset rather than an actual lot photograph.
 */
export function isCatalogueReferencePhotoUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  if (extractPrefixedAssetPath(url, CATALOGUE_PHOTO_PREFIX) !== null) {
    return true;
  }
  try {
    const pathname = new URL(url.trim()).pathname.toLowerCase();
    return pathname.includes('/catalogue-photos/') || /\/published\/[a-z0-9-]+\/[a-z0-9-]+\//.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Resolves the storefront display badge kind for a standard product image.
 * Bundled demo images retain `Sample Photo (Demo)` while library images receive
 * `Catalogue reference photo`.
 */
export function getProductImageBadgeKind(input: {
  imageUrl?: string | null;
  isCatalogueReferencePhoto?: boolean | null;
  cataloguePhotoId?: string | null;
}): ProductImageBadgeKind {
  if (isDemoSamplePhotoUrl(input.imageUrl)) {
    return 'SAMPLE_DEMO';
  }
  if (
    input.isCatalogueReferencePhoto === true ||
    Boolean(input.cataloguePhotoId) ||
    isCatalogueReferencePhotoUrl(input.imageUrl)
  ) {
    return 'CATALOGUE_REFERENCE';
  }
  return null;
}

/**
 * Resolves Wikimedia Commons attribution and modification metadata for a
 * bundled `/demo-products/*` sample asset, if known.
 */
export function getDemoSamplePhotoCredit(
  url: string | null | undefined,
): DemoSamplePhotoCredit | null {
  const pathname = extractPrefixedAssetPath(url, DEMO_SAMPLE_PHOTO_PREFIX);
  if (!pathname) {
    return null;
  }
  return DEMO_SAMPLE_PHOTO_CREDITS[pathname] ?? null;
}
