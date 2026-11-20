// Structural/no-wiring invariants for the CheckoutAttempt module (Phase
// 16A.0-A). Split out of checkout-attempt-failure-pagination.service.spec.ts
// to keep every file within the repository's 400-line cap - these checks
// are not part of markFailed/findStalePage behavior, they guard the
// module's isolation boundary (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
describe('CheckoutAttempt module boundary', () => {
  describe('no Prisma access outside the repository', () => {
    it('never references PrismaService or prisma.checkoutAttempt outside repositories/', () => {
      const fs = jest.requireActual<typeof import('fs')>('fs');
      const path = jest.requireActual<typeof import('path')>('path');
      const moduleRoot = path.resolve(__dirname, '..');
      const scanDirs = ['services', 'types'].map((rel) => path.join(moduleRoot, rel));

      function collectTsFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap((entry: import('fs').Dirent) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return collectTsFiles(full);
          return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
        });
      }

      const offenders: string[] = [];
      for (const dir of scanDirs) {
        for (const file of collectTsFiles(dir)) {
          const codeLines = fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter((line: string) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
          const code = codeLines.join('\n');
          if (code.includes('PrismaService') || code.includes('prisma.checkoutAttempt')) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('production module import boundary (ADR-007 wiring)', () => {
    it('is only imported in orders/cart/products production modules by OrdersModule', () => {
      const fs = jest.requireActual<typeof import('fs')>('fs');
      const path = jest.requireActual<typeof import('path')>('path');
      const modulesRoot = path.resolve(__dirname, '../..');
      const roots = ['cart', 'orders', 'products'].map((rel) => path.join(modulesRoot, rel));
      const allowedImporters = new Set(['orders/orders.module.ts']);

      function collectProdTsFiles(dir: string): string[] {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.flatMap((entry: import('fs').Dirent) => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) return collectProdTsFiles(full);
          return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
        });
      }

      const offenders: string[] = [];
      for (const root of roots) {
        for (const file of collectProdTsFiles(root)) {
          const rel = path.relative(modulesRoot, file).replace(/\\/g, '/');
          if (allowedImporters.has(rel)) continue;
          const contents = fs.readFileSync(file, 'utf8');
          if (contents.includes('CheckoutAttemptModule') || contents.includes('CheckoutAttemptService')) {
            offenders.push(rel);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });
});
