import { AppModule } from '../../../app.module';
import { PrismaModule } from '../../../database/prisma.module';
import { RedisModule } from '../../../common/redis/redis.module';
import { ReservationFenceModule } from '../reservation-fence.module';
import { ReservationFenceService } from '../services/reservation-fence.service';
import { ReservationCapabilityService } from '../services/reservation-capability.service';

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
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(1);
  });
});
