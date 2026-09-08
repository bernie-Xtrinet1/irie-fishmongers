import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { CheckoutAttemptModule } from '../checkout-attempt/checkout-attempt.module';
import { CheckoutOperationModule } from '../checkout-operation/checkout-operation.module';
import { CheckoutShadowModule } from '../checkout-shadow/checkout-shadow.module';
import { OrdersModule } from '../orders/orders.module';
import { CheckoutDispatchService } from './services/checkout-dispatch.service';
import {
  CheckoutAdmissionService,
  InactiveCheckoutAdmissionService,
} from './services/checkout-admission.service';

// Internal only. No controller and no production importer.
@Module({
  imports: [
    CheckoutModule,
    CheckoutAttemptModule,
    CheckoutOperationModule,
    CheckoutShadowModule,
    OrdersModule,
  ],
  providers: [
    CheckoutDispatchService,
    { provide: CheckoutAdmissionService, useClass: InactiveCheckoutAdmissionService },
  ],
  exports: [CheckoutDispatchService],
})
export class CheckoutDispatchModule {}
