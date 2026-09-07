import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../database/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { CheckoutShadowModule } from './checkout-shadow.module';
import { CheckoutShadowComparisonService } from './services/checkout-shadow-comparison.service';
import { CheckoutCoordinatorService } from '../checkout/services/checkout-coordinator.service';
import { OrdersService } from '../orders/services/orders.service';
import { PaymentsService } from '../payments/services/payments.service';
import { InventoryReservationsService } from '../inventory/services/inventory-reservations.service';
import { CheckoutRolloutPolicyService } from '../checkout-rollout/services/checkout-rollout-policy.service';

describe('CheckoutShadowModule inactive dependency boundary', () => {
  it('resolves locally with no controllers, mutating services, policy routing, or provider calls', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CheckoutShadowModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(REDIS_CLIENT)
      .useValue({ disconnect: jest.fn() })
      .compile();
    expect(moduleRef.get(CheckoutShadowComparisonService)).toBeInstanceOf(
      CheckoutShadowComparisonService,
    );
    const graph = [...moduleRef.get(ModulesContainer).values()];
    for (const entry of graph) {
      expect(entry.controllers.size).toBe(0);
      for (const forbidden of [
        CheckoutCoordinatorService,
        OrdersService,
        PaymentsService,
        InventoryReservationsService,
        CheckoutRolloutPolicyService,
      ]) {
        expect(entry.providers.has(forbidden)).toBe(false);
      }
    }
    await moduleRef.close();
  });

  it('has no production importer in the actual Nest module graph', () => {
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
        expect(entry).not.toBe(CheckoutShadowModule);
        expect(
          (Reflect.getMetadata('providers', entry) as unknown[] | undefined) ?? [],
        ).not.toContain(CheckoutShadowComparisonService);
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(1);
  });
});
