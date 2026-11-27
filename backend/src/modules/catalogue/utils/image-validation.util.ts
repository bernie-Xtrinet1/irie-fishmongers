import { BadRequestException } from '@nestjs/common';

export const ALLOWED_CATALOGUE_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type AllowedCatalogueImageMime = (typeof ALLOWED_CATALOGUE_IMAGE_MIMES)[number];

export const MAX_CATALOGUE_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MIN_CATALOGUE_IMAGE_WIDTH = 400;
export const MIN_CATALOGUE_IMAGE_HEIGHT = 300;
export const MAX_CATALOGUE_IMAGE_DIMENSION = 6000;

export interface ValidatedCatalogueImage {
  mimeType: AllowedCatalogueImageMime;
  extension: 'png' | 'jpg' | 'webp';
  widthPx: number;
  heightPx: number;
  fileSizeBytes: number;
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return null;
  }
  const ihdr = buf.toString('ascii', 12, 16);
  if (ihdr !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buf.length) {
    // Sync to marker byte 0xFF
    if (buf[offset] !== 0xff) {
      return null;
    }
    while (offset < buf.length && buf[offset] === 0xff) {
      offset++;
    }
    if (offset >= buf.length) break;

    const marker = buf[offset]!;
    offset++;

    // Standalone markers without length payload (RST0-7, SOI, EOI, TEM)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) break;
      continue;
    }

    if (offset + 1 >= buf.length) break;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buf.length) {
      return null;
    }

    // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 encode image frame dimensions
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      if (segmentLength < 7 || offset + 7 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // Stop scanning at Start Of Scan
    if (marker === 0xda) break;

    offset += segmentLength;
  }

  return null;
}

function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (
    buf.length < 30 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  const chunkHeader = buf.toString('ascii', 12, 16);
  if (chunkHeader === 'VP8 ') {
    // Lossy VP8 bitstream keyframe header (starts at byte 20)
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (chunkHeader === 'VP8L') {
    // Lossless VP8L bitstream
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (chunkHeader === 'VP8X') {
    // Extended VP8X canvas size (24-bit little-endian minus 1 at bytes 24..29)
    if (buf.length < 30) return null;
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }

  return null;
}

/**
 * Validates uploaded catalogue photo bytes directly from container/binary headers
 * (never trusting filename extensions or unverified Content-Type alone), enforces
 * size limits, and extracts exact pixel dimensions.
 */
export function validateCatalogueImageFile(file: {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
}): ValidatedCatalogueImage {
  const buf = file?.buffer;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    throw new BadRequestException('An image file (PNG, JPEG, or WebP) is required.');
  }

  const byteSize = file.size ?? buf.length;
  if (byteSize > MAX_CATALOGUE_IMAGE_BYTES || buf.length > MAX_CATALOGUE_IMAGE_BYTES) {
    throw new BadRequestException(
      `Image file exceeds the ${MAX_CATALOGUE_IMAGE_BYTES / (1024 * 1024)} MiB size limit.`,
    );
  }

  const normalizedMime = (file.mimetype || '').toLowerCase().trim();
  const normalizedDeclMime = normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime;

  const pngDims = parsePngDimensions(buf);
  const jpegDims = pngDims ? null : parseJpegDimensions(buf);
  const webpDims = pngDims || jpegDims ? null : parseWebpDimensions(buf);

  let detectedMime: AllowedCatalogueImageMime | null = null;
  let extension: 'png' | 'jpg' | 'webp' | null = null;
  let dims: { width: number; height: number } | null = null;

  if (pngDims) {
    detectedMime = 'image/png';
    extension = 'png';
    dims = pngDims;
  } else if (jpegDims) {
    detectedMime = 'image/jpeg';
    extension = 'jpg';
    dims = jpegDims;
  } else if (webpDims) {
    detectedMime = 'image/webp';
    extension = 'webp';
    dims = webpDims;
  }

  if (!detectedMime || !extension || !dims) {
    throw new BadRequestException(
      'Unsupported or corrupted image file. Upload a valid PNG, JPEG, or WebP photograph.',
    );
  }

  if (normalizedDeclMime && normalizedDeclMime !== detectedMime) {
    throw new BadRequestException(
      `Declared image MIME type "${normalizedDeclMime}" does not match the actual ${detectedMime} file header.`,
    );
  }

  if (dims.width < MIN_CATALOGUE_IMAGE_WIDTH || dims.height < MIN_CATALOGUE_IMAGE_HEIGHT) {
    throw new BadRequestException(
      `Image dimensions (${dims.width}x${dims.height}px) are too small; minimum supported size is ${MIN_CATALOGUE_IMAGE_WIDTH}x${MIN_CATALOGUE_IMAGE_HEIGHT}px.`,
    );
  }

  if (dims.width > MAX_CATALOGUE_IMAGE_DIMENSION || dims.height > MAX_CATALOGUE_IMAGE_DIMENSION) {
    throw new BadRequestException(
      `Image dimensions (${dims.width}x${dims.height}px) exceed maximum ${MAX_CATALOGUE_IMAGE_DIMENSION}x${MAX_CATALOGUE_IMAGE_DIMENSION}px.`,
    );
  }

  return {
    mimeType: detectedMime,
    extension,
    widthPx: dims.width,
    heightPx: dims.height,
    fileSizeBytes: buf.length,
  };
}
