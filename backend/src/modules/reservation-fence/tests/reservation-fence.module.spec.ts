import { AppModule } from '../../../app.module';
import { PrismaModule } from '../../../database/prisma.module';
import { RedisModule } from '../../../common/redis/redis.module';
import { ReservationFenceModule } from '../reservation-fence.module';
import { ReservationFenceService } from '../services/reservation-fence.service';
import { ReservationCapabilityService } from '../services/reservation-capability.service';
import { ReservationMutationAuthorityService } from '../services/reservation-mutation-authority.service';
import { ReservationFencedExecutor } from '../services/reservation-fenced-executor.service';
import { CheckoutFailureSettlementService } from '../../checkout/services/checkout-failure-settlement.service';
import { CheckoutDispatchService } from '../../checkout-dispatch/services/checkout-dispatch.service';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('G.4b.1 inactive dependency boundary', () => {
  it('imports only infrastructure and has no controller', () => {
    expect(Reflect.getMetadata('imports', ReservationFenceModule)).toEqual([PrismaModule, RedisModule]);
    expect(Reflect.getMetadata('controllers', ReservationFenceModule) ?? []).toEqual([]);
  });
  it('is absent from the actual production module graph', () => {
    const seen = new Set<unknown>();
    function visit(entry: unknown): void {
      if (!entry || seen.has(entry)) return;
      seen.add(entry);
      if (typeof entry === 'object') {
        const dynamic = entry as { module?: unknown; imports?: unknown[]; forwardRef?: () => unknown };
        if (dynamic.forwardRef) visit(dynamic.forwardRef());
        if (dynamic.module) visit(dynamic.module);
        dynamic.imports?.forEach(visit);
      } else if (typeof entry === 'function') {
        expect(entry).not.toBe(ReservationFenceModule);
        const providers = (Reflect.getMetadata('providers', entry) as unknown[] | undefined) ?? [];
        expect(providers).not.toContain(ReservationFenceService);
        expect(providers).not.toContain(ReservationCapabilityService);
        expect(providers).not.toContain(ReservationMutationAuthorityService);
        expect(providers).not.toContain(ReservationFencedExecutor);
        expect(providers).not.toContain(CheckoutFailureSettlementService);
        expect(providers).not.toContain(CheckoutDispatchService);
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(1);
  });
  it('only W4, W5 settlement and W7 use fenced inventory Lua; read-side suspect writer remains removed', () => {
    const inventory = join(__dirname, '../../inventory');
    for (const file of readdirSync(join(inventory, 'lua'))) {
      const source = readFileSync(join(inventory, 'lua', file), 'utf8');
      if (file === 'checkout-lease-extend-lua-scripts.ts') expect(source).toContain("compileFencedMutation('CHECKOUT_LEASE_EXTEND'" );
      else if (file === 'checkout-acquire-lua-scripts.ts') expect(source).toContain("settlementProtocol('ACQUIRE'");
      else if (file === 'checkout-settlement-revert-lua-scripts.ts') expect(source).toContain("settlementProtocol('CHECKOUT_REVERT_DELETE_ONLY'");
      else expect(source).not.toMatch(/mutationGuard|compileFencedMutation|reservation:fence/);
    }
    expect(readFileSync(join(inventory, 'services/inventory-reservations-script-helpers.ts'), 'utf8'))
      .not.toMatch(/flagMalformedReservation|redis\.set/);
  });
});
