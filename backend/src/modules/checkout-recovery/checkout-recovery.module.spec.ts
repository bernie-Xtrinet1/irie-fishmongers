import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { CheckoutRecoveryModule } from './checkout-recovery.module';
import { CheckoutRecoverySchedulerService } from './services/checkout-recovery-scheduler.service';
import { CheckoutCoordinatorService } from '../checkout/services/checkout-coordinator.service';
import { CheckoutRolloutPolicyService } from '../checkout-rollout/services/checkout-rollout-policy.service';
import { PaymentsService } from '../payments/services/payments.service';

describe('Checkout recovery module admission boundary', () => {
  it('resolves the scheduler without coordinator, rollout policy, payment service or controllers', async () => {
    const testingModule = await Test.createTestingModule({ imports: [CheckoutRecoveryModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .overrideProvider(REDIS_CLIENT)
      .useValue({})
      .compile();
    try {
      expect(testingModule.get(CheckoutRecoverySchedulerService)).toBeDefined();
      for (const token of [
        CheckoutCoordinatorService,
        CheckoutRolloutPolicyService,
        PaymentsService,
      ]) {
        expect(() => testingModule.get(token)).toThrow();
      }
      expect(
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CheckoutRecoveryModule) ?? [],
      ).toEqual([]);
    } finally {
      await testingModule.close();
    }
  });
});
