import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { validateEnv } from '../../config/env.validation';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';
import { RedisModule } from '../../common/redis/redis.module';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { CheckoutDispatchModule } from './checkout-dispatch.module';
import { CheckoutDispatchService } from './services/checkout-dispatch.service';
import {
  CheckoutAdmissionService,
  InactiveCheckoutAdmissionService,
} from './services/checkout-admission.service';

describe('G.2b inactive module', () => {
  it('resolves through the real Nest graph with safe default admission', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        PrismaModule,
        RedisModule,
        EventEmitterModule.forRoot(),
        CheckoutDispatchModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ $disconnect: jest.fn() })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ disconnect: jest.fn() })
      .compile();
    try {
      expect(moduleRef.get(CheckoutDispatchService)).toBeInstanceOf(CheckoutDispatchService);
      expect(moduleRef.get(CheckoutAdmissionService)).toBeInstanceOf(
        InactiveCheckoutAdmissionService,
      );
    } finally {
      await moduleRef.close();
    }
  });
  it('has no controller and is absent from the production module graph', () => {
    expect(
      (Reflect.getMetadata('controllers', CheckoutDispatchModule) as unknown[] | undefined) ?? [],
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
        expect(entry).not.toBe(CheckoutDispatchModule);
        expect(
          (Reflect.getMetadata('providers', entry) as unknown[] | undefined) ?? [],
        ).not.toContain(CheckoutDispatchService);
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.size).toBeGreaterThan(1);
  });
});
