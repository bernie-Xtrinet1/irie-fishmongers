import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CheckoutAttemptModule } from '../checkout-attempt/checkout-attempt.module';
import { ReservationFenceRepository } from '../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementRepository } from '../reservation-fence/repositories/checkout-settlement.repository';
import { CheckoutSettlementAuthorityService } from '../reservation-fence/services/checkout-settlement-authority.service';
import { CheckoutRecoveryAcquisitionEvidenceService } from './services/checkout-recovery-acquisition-evidence.service';
import { CheckoutRecoverySettlementRepository } from './repositories/checkout-recovery-settlement.repository';
import { CheckoutStaleSettlementService } from './services/checkout-stale-settlement.service';
import { CheckoutRecoveryLockService } from './services/checkout-recovery-lock.service';
import { CheckoutRecoveryWorkerService } from './services/checkout-recovery-worker.service';
import { CheckoutRecoverySchedulerService } from './services/checkout-recovery-scheduler.service';
import { CheckoutRecoveryTelemetryService } from './services/checkout-recovery-telemetry.service';

// Recovery-only: no coordinator, order/payment modules, policy or controllers.
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, CheckoutAttemptModule],
  providers: [
    ReservationFenceRepository,
    CheckoutSettlementRepository,
    CheckoutSettlementAuthorityService,
    CheckoutRecoveryAcquisitionEvidenceService,
    CheckoutRecoverySettlementRepository,
    CheckoutStaleSettlementService,
    CheckoutRecoveryLockService,
    CheckoutRecoveryWorkerService,
    CheckoutRecoverySchedulerService,
    CheckoutRecoveryTelemetryService,
  ],
})
export class CheckoutRecoveryModule {}
