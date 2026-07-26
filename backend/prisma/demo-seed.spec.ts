import { DEMO_PRODUCTS } from './demo-seed';

// Regression guard for the broken-product-images bug: next/image's optimizer
// rejects SVG with HTTP 400 ("url parameter is valid but image type is not
// allowed"), and placehold.co serves SVG unless the path contains "/png". The
// demo seed must therefore only ever use raster placeholder URLs.
describe('demo seed product placeholders', () => {
  it('seeds at least one product', () => {
    expect(DEMO_PRODUCTS.length).toBeGreaterThan(0);
  });

  it('uses raster (PNG) placeholders, never SVG', () => {
    for (const product of DEMO_PRODUCTS) {
      expect(product.imageUrl).toContain('/png?');
    }
  });

  it('never uses the SVG-style placehold.co URL (no "/png" segment)', () => {
    for (const product of DEMO_PRODUCTS) {
      expect(product.imageUrl).not.toMatch(/placehold\.co\/\d+x\d+\?text=/);
    }
  });
});
