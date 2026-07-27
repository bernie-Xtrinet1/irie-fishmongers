import * as fs from 'fs';
import * as path from 'path';

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

  it('references image files that exist in apps/web/public', () => {
    for (const product of DEMO_PRODUCTS) {
      const file = path.join(PUBLIC_DIR, product.imageUrl);
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});
