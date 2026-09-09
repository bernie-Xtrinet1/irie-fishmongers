import { Module } from '@nestjs/common';
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
    CheckoutModule,
    CheckoutAttemptModule,
    CheckoutOperationModule,
    CheckoutShadowModule,
    OrdersModule,
  ],
  providers: [
    CheckoutDispatchService,
    CheckoutOperationRepository,
    CheckoutAttemptRepository,
    CheckoutRolloutParticipantsRepository,
    RolloutControlsRepository,
    { provide: CheckoutAdmissionService, useClass: AtomicCheckoutAdmissionService },
  ],
  exports: [CheckoutDispatchService],
})
export class CheckoutDispatchModule {}
