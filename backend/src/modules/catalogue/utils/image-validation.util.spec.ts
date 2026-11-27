import { BadRequestException } from '@nestjs/common';

import {
  MAX_CATALOGUE_IMAGE_BYTES,
  validateCatalogueImageFile,
} from './image-validation.util';

function buildMinimalPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type RGB
  return buf;
}

function buildMinimalJpeg(width: number, height: number): Buffer {
  // SOI (2) + SOF0 marker (2) + length (2) + precision (1) + height (2) + width (2)
  const buf = Buffer.alloc(16);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function buildMinimalWebpVp8(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(12, 16);
  // 3-byte frame tag + 0x9d 0x01 0x2a start code
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

describe('validateCatalogueImageFile', () => {
  it('accepts valid PNG, JPEG, and WebP buffers with compliant dimensions', () => {
    expect(
      validateCatalogueImageFile({
        buffer: buildMinimalPng(900, 600),
        mimetype: 'image/png',
      }),
    ).toEqual({
      mimeType: 'image/png',
      extension: 'png',
      widthPx: 900,
      heightPx: 600,
      fileSizeBytes: 32,
    });

    expect(
      validateCatalogueImageFile({
        buffer: buildMinimalJpeg(1200, 800),
        mimetype: 'image/jpeg',
      }),
    ).toEqual({
      mimeType: 'image/jpeg',
      extension: 'jpg',
      widthPx: 1200,
      heightPx: 800,
      fileSizeBytes: 16,
    });

    expect(
      validateCatalogueImageFile({
        buffer: buildMinimalWebpVp8(800, 600),
        mimetype: 'image/webp',
      }),
    ).toEqual({
      mimeType: 'image/webp',
      extension: 'webp',
      widthPx: 800,
      heightPx: 600,
      fileSizeBytes: 32,
    });
  });

  it('rejects SVG or spoofed Content-Type bytes', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    expect(() =>
      validateCatalogueImageFile({ buffer: svg, mimetype: 'image/png' }),
    ).toThrow(BadRequestException);

    // PNG header disguised with image/jpeg mimetype
    expect(() =>
      validateCatalogueImageFile({
        buffer: buildMinimalPng(900, 600),
        mimetype: 'image/jpeg',
      }),
    ).toThrow(/does not match/);
  });

  it('rejects images below 400x300 minimum dimensions or above 5 MiB limit', () => {
    expect(() =>
      validateCatalogueImageFile({
        buffer: buildMinimalPng(200, 200),
        mimetype: 'image/png',
      }),
    ).toThrow(/minimum supported size/);

    expect(() =>
      validateCatalogueImageFile({
        buffer: buildMinimalPng(900, 600),
        mimetype: 'image/png',
        size: MAX_CATALOGUE_IMAGE_BYTES + 1,
      }),
    ).toThrow(/exceeds/);
  });
});
