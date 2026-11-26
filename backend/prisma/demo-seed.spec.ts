import * as fs from 'fs';
import * as path from 'path';

import {
  CATALOGUE_PHOTO_DEFINITIONS,
  SPECIES_DEFINITIONS,
} from './catalogue-photo-seed';
import { DEMO_PRODUCTS } from './demo-seed';

// Regression guard for the broken-product-images bug: next/image's optimizer
// rejects SVG with HTTP 400 ("url parameter is valid but image type is not
// allowed"). The demo now ships LOCAL raster images (apps/web/public/
// demo-products/) to avoid remote/SVG/network failure modes entirely. This
// test asserts the seed keeps referencing local raster files that actually
// exist on disk - so a regression to a remote SVG URL, or a missing file,
// fails CI before the demo does.
const PUBLIC_DIR = path.resolve(__dirname, '../../apps/web/public');

describe('demo seed product placeholders', () => {
  it('seeds at least one product', () => {
    expect(DEMO_PRODUCTS.length).toBeGreaterThan(0);
  });

  it('uses local raster image paths, never a remote or SVG URL', () => {
    for (const product of DEMO_PRODUCTS) {
      expect(product.imageUrl).toMatch(/^\/demo-products\/[\w-]+\.(png|jpg|jpeg|webp)$/);
      expect(product.imageUrl).not.toMatch(/^https?:/);
      expect(product.imageUrl).not.toMatch(/\.svg$/i);
    }
  });

  it('references non-placeholder image files that exist in apps/web/public', () => {
    for (const product of DEMO_PRODUCTS) {
      const file = path.join(PUBLIC_DIR, product.imageUrl);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(10_000);
    }
  });

  it('includes labelled sample raster files for broader species catalogue previews', () => {
    const previewFiles = [
      '/demo-products/red-snapper.png',
      '/demo-products/jumbo-shrimp.png',
      '/demo-products/lobster.png',
      '/demo-products/king-fish.png',
      '/demo-products/mackerel.png',
    ];

    for (const relativePath of previewFiles) {
      const file = path.join(PUBLIC_DIR, relativePath);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(10_000);
    }
  });

  it('ships verified library photos, rights metadata, and keeps Conch RESTRICTED', () => {
    const conch = SPECIES_DEFINITIONS.find((s) => s.commercialName === 'Conch');
    expect(conch?.regulatoryStatus).toBe('RESTRICTED');
    expect(SPECIES_DEFINITIONS.some((s) => s.commercialName === 'Tilapia')).toBe(true);

    for (const entry of CATALOGUE_PHOTO_DEFINITIONS) {
      const file = path.join(PUBLIC_DIR, entry.imageUrl);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(10_000);
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
      expect(entry.photographer.length).toBeGreaterThan(0);
      expect(entry.licenseName.length).toBeGreaterThan(0);
      expect(entry.modifications.length).toBeGreaterThan(0);
      expect(entry.jamaicanAliases.length).toBeGreaterThan(0);
    }

    const conchPhotos = CATALOGUE_PHOTO_DEFINITIONS.filter(
      (entry) => entry.speciesScientificName === 'Lobatus gigas',
    );
    expect(conchPhotos).toHaveLength(0);
  });

  it('keeps public photo credit SOURCES.md files un-ignored in .dockerignore', () => {
    const dockerignore = fs.readFileSync(
      path.resolve(__dirname, '../../.dockerignore'),
      'utf8',
    );
    expect(fs.existsSync(path.join(PUBLIC_DIR, '/demo-products/SOURCES.md'))).toBe(true);
    expect(fs.existsSync(path.join(PUBLIC_DIR, '/catalogue-photos/SOURCES.md'))).toBe(true);
    expect(dockerignore).toContain('!apps/web/public/demo-products/SOURCES.md');
    expect(dockerignore).toContain('!apps/web/public/catalogue-photos/SOURCES.md');
  });
});
