import { Test } from '@nestjs/testing';
import { ModulesContainer } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { CheckoutDispatchModule } from '../checkout-dispatch/checkout-dispatch.module';
import { CheckoutRolloutAdminModule } from '../checkout-rollout-admin/checkout-rollout-admin.module';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';
import { CheckoutRolloutModule } from './checkout-rollout.module';
import { CheckoutRolloutParticipantsRepository } from './repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutParticipantsService } from './services/checkout-rollout-participants.service';
import { CheckoutRolloutPolicyService } from './services/checkout-rollout-policy.service';

describe('CheckoutRolloutModule inactive boundary', () => {
  it('resolves locally with only its persistence dependency and no controllers', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CheckoutRolloutModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(moduleRef.get(CheckoutRolloutPolicyService)).toBeInstanceOf(
      CheckoutRolloutPolicyService,
    );
    expect(moduleRef.get(CheckoutRolloutParticipantsService)).toBeInstanceOf(
      CheckoutRolloutParticipantsService,
    );
    expect(Reflect.getMetadata('controllers', CheckoutRolloutModule) ?? []).toEqual([]);
    const graph = moduleRef.get(ModulesContainer);
    const rollout = [...graph.values()].find((entry) => entry.metatype === CheckoutRolloutModule)!;
    expect([...rollout.imports].map((entry) => entry.metatype)).toContain(PrismaModule);
    expect([...rollout.controllers.values()]).toEqual([]);
    expect(Reflect.getMetadata('providers', CheckoutRolloutModule)).toEqual([
      CheckoutRolloutParticipantsRepository,
      CheckoutRolloutParticipantsService,
      CheckoutRolloutPolicyService,
    ]);
    expect(
      Object.getOwnPropertyNames(CheckoutRolloutParticipantsRepository.prototype).sort(),
    ).toEqual(['appendIfCurrent', 'constructor', 'findCurrent', 'listHistory']);
    await moduleRef.close();
  });

  it('is reachable for administration without making the dispatcher reachable', () => {
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
        const imports = (Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? [];
        imports.forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.has(PrismaModule)).toBe(true);
    expect(seen.has(CheckoutRolloutModule)).toBe(true);
    expect(seen.has(CheckoutRolloutAdminModule)).toBe(true);
  });
});
