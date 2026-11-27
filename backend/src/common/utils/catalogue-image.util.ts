import { registerDecorator, ValidationOptions, isURL } from 'class-validator';

const CATALOGUE_PHOTO_PREFIX = '/catalogue-photos/';
const DEMO_PRODUCT_PREFIX = '/demo-products/';
const ADMIN_CATALOGUE_PHOTO_ENDPOINT_FRAGMENT = '/admin/catalogue-photos/';
const PUBLIC_CATALOGUE_PHOTO_IMAGE_FRAGMENT = '/catalogue/photos/';
const BLOB_HOST_CATALOGUE_PATTERN =
  /\/(?:catalogue-photos(?:-drafts)?|published\/[a-z0-9-]+\/[a-z0-9-]+|drafts\/[a-z0-9-]+\/[a-z0-9-]+)\//i;
const SAFE_BUNDLED_IMAGE_PATTERN = /^\/(?:catalogue-photos|demo-products)\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp)$/i;

export function extractImagePathname(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return trimmed.split(/[?#]/)[0] || trimmed;
  }
  try {
    return new URL(trimmed).pathname;
  } catch {
    return null;
  }
}

export function isCataloguePhotoPathUrl(rawUrl: string | null | undefined): boolean {
  const pathname = extractImagePathname(rawUrl);
  if (!pathname) {
    return false;
  }
  const lower = pathname.toLowerCase();
  if (
    lower.startsWith(CATALOGUE_PHOTO_PREFIX) ||
    lower.includes(ADMIN_CATALOGUE_PHOTO_ENDPOINT_FRAGMENT) ||
    (lower.includes(PUBLIC_CATALOGUE_PHOTO_IMAGE_FRAGMENT) && lower.endsWith('/image'))
  ) {
    return true;
  }

  // Catch Blob-hosted catalogue storage keys/containers (Azure *.blob.core.windows.net
  // or local Azurite /devstoreaccount1/catalogue-photos/published/... paths).
  if (BLOB_HOST_CATALOGUE_PATTERN.test(lower)) {
    return true;
  }

  const configuredBase = process.env.AZURE_STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configuredBase && rawUrl!.trim().toLowerCase().startsWith(configuredBase.toLowerCase())) {
    return true;
  }

  return false;
}

export function isBundledImagePath(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) {
    return false;
  }
  return SAFE_BUNDLED_IMAGE_PATTERN.test(rawUrl.trim());
}

export function isValidProductImageUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return false;
  }
  if (isBundledImagePath(trimmed)) {
    return true;
  }
  return isURL(trimmed, {
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  });
}

export function normalizeUrlCandidatePaths(rawUrl: string): string[] {
  const trimmed = rawUrl.trim();
  const candidates = new Set<string>([trimmed]);
  try {
    const parsed = new URL(trimmed);
    const originAndPath = `${parsed.origin}${parsed.pathname}`;
    candidates.add(originAndPath);
    candidates.add(originAndPath.toLowerCase());
  } catch {
    // Not an absolute URL; strip ?query/#fragment if present
    const noQuery = trimmed.split(/[?#]/)[0];
    if (noQuery) {
      candidates.add(noQuery);
    }
  }
  const pathname = extractImagePathname(trimmed);
  if (pathname && (pathname.startsWith(CATALOGUE_PHOTO_PREFIX) || pathname.startsWith(DEMO_PRODUCT_PREFIX))) {
    candidates.add(pathname);
  }
  return Array.from(candidates);
}

export function extractStorageKeyCandidates(rawUrl: string): string[] {
  const pathname = extractImagePathname(rawUrl);
  if (!pathname) {
    return [];
  }
  const clean = pathname.replace(/^\/+/, '');
  const keys = new Set<string>();
  const markers = ['published/', 'drafts/'];
  for (const marker of markers) {
    const idx = clean.toLowerCase().indexOf(marker);
    if (idx !== -1) {
      keys.add(clean.slice(idx));
    }
  }
  return Array.from(keys);
}

export function IsProductImageUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isProductImageUrl',
      target: object.constructor,
      propertyName,
      options: {
        message: 'imageUrl must be a valid HTTP/HTTPS URL or bundled /catalogue-photos/ image path',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          return isValidProductImageUrl(value);
        },
      },
    });
  };
}
