import { Module } from '@nestjs/common';
import { RedisModule } from '../../common/redis/redis.module';
import { ReservationFenceModule } from '../reservation-fence/reservation-fence.module';
import { CheckoutAcquisitionService } from '../checkout/services/checkout-acquisition.service';
import { CheckoutFailureSettlementService } from '../checkout/services/checkout-failure-settlement.service';
import { CheckoutFinalizeSettlementService } from '../checkout/services/checkout-finalize-settlement.service';
import { CheckoutModule } from '../checkout/checkout.module';
import { CheckoutAttemptModule } from '../checkout-attempt/checkout-attempt.module';
import { CheckoutOperationModule } from '../checkout-operation/checkout-operation.module';
import { CheckoutShadowModule } from '../checkout-shadow/checkout-shadow.module';
import { OrdersModule } from '../orders/orders.module';
import { CheckoutDispatchService } from './services/checkout-dispatch.service';
import { CheckoutAdmissionService } from './services/checkout-admission.service';
import { AtomicCheckoutAdmissionService } from './services/atomic-checkout-admission.service';
import { PrismaModule } from '../../database/prisma.module';
import { CheckoutOperationRepository } from '../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutRolloutParticipantsRepository } from '../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { RolloutControlsRepository } from '../checkout-rollout-admin/repositories/rollout-controls.repository';

// Internal only. No controller and no production importer.
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ReservationFenceModule,
    CheckoutModule,
    CheckoutAttemptModule,
    CheckoutOperationModule,
    CheckoutShadowModule,
    OrdersModule,
  ],
  providers: [
    CheckoutDispatchService,
    CheckoutAcquisitionService,
    CheckoutFailureSettlementService,
    CheckoutFinalizeSettlementService,
    CheckoutOperationRepository,
    CheckoutAttemptRepository,
    CheckoutRolloutParticipantsRepository,
    RolloutControlsRepository,
    { provide: CheckoutAdmissionService, useClass: AtomicCheckoutAdmissionService },
  ],
  exports: [CheckoutDispatchService],
})
export class CheckoutDispatchModule {}
