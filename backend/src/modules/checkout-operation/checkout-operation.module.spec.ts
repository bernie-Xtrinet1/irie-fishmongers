import { AppModule } from '../../app.module';
import { CheckoutOperationModule } from './checkout-operation.module';
import { CheckoutOperationService } from './services/checkout-operation.service';

describe('G.PR2 inactive production boundary', () => {
  it('has no controller and is absent from the actual production import graph', () => {
    expect(
      (Reflect.getMetadata('controllers', CheckoutOperationModule) as unknown[] | undefined) ?? [],
    ).toEqual([]);
    const seen = new Set<unknown>();
    function visit(entry: unknown): void {
      if (!entry || seen.has(entry)) return;
      seen.add(entry);
      if (typeof entry === 'object') {
        const dynamic = entry as {
          module?: unknown;
          imports?: unknown[];
          forwardRef?: () => unknown;
        };
        if (dynamic.forwardRef) visit(dynamic.forwardRef());
        if (dynamic.module) visit(dynamic.module);
        dynamic.imports?.forEach(visit);
      } else if (typeof entry === 'function') {
        expect(entry).not.toBe(CheckoutOperationModule);
        expect(
          (Reflect.getMetadata('providers', entry) as unknown[] | undefined) ?? [],
        ).not.toContain(CheckoutOperationService);
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(1);
  });
});
