import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CheckoutAttemptModule } from '../checkout-attempt/checkout-attempt.module';
import { CheckoutReservationRecoveryService } from '../inventory/services/checkout-reservation-recovery.service';
import { CheckoutRecoveryLockService } from './services/checkout-recovery-lock.service';
import { CheckoutRecoveryWorkerService } from './services/checkout-recovery-worker.service';
import { CheckoutRecoverySchedulerService } from './services/checkout-recovery-scheduler.service';
import { CheckoutRecoveryTelemetryService } from './services/checkout-recovery-telemetry.service';

// Recovery-only: no coordinator, order/payment modules, policy or controllers.
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, CheckoutAttemptModule],
  providers: [
    CheckoutReservationRecoveryService,
    CheckoutRecoveryLockService,
    CheckoutRecoveryWorkerService,
    CheckoutRecoverySchedulerService,
    CheckoutRecoveryTelemetryService,
  ],
})
export class CheckoutRecoveryModule {}
