import { registerDecorator, ValidationOptions, isURL } from 'class-validator';

const CATALOGUE_PHOTO_PREFIX = '/catalogue-photos/';
const DEMO_PRODUCT_PREFIX = '/demo-products/';
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
    return trimmed;
  }
  try {
    return new URL(trimmed).pathname;
  } catch {
    return null;
  }
}

export function isCataloguePhotoPathUrl(rawUrl: string | null | undefined): boolean {
  const pathname = extractImagePathname(rawUrl);
  return pathname ? pathname.toLowerCase().startsWith(CATALOGUE_PHOTO_PREFIX) : false;
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
  const pathname = extractImagePathname(trimmed);
  if (pathname && (pathname.startsWith(CATALOGUE_PHOTO_PREFIX) || pathname.startsWith(DEMO_PRODUCT_PREFIX))) {
    candidates.add(pathname);
  }
  return Array.from(candidates);
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
