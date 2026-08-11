import { Module } from '@nestjs/common';

import { CheckoutAttemptModule } from '../checkout-attempt/checkout-attempt.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { PriceLockModule } from '../price-lock/price-lock.module';
import { CheckoutCoordinatorService } from './services/checkout-coordinator.service';

// Phase 16A.0-D, Unit D.4 (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Packages the already-tested D-core saga (D.1-D.3) into a real Nest
// module/DI graph for the first time - CheckoutCoordinatorService was
// previously only ever unit-tested with manual mocks or constructed
// directly with `new` in D.3's real-infrastructure integration helper,
// never resolved through Nest's module system. Additive and unwired: no
// controller, no idempotency-key route, not imported by AppModule. Only
// the modules CheckoutCoordinatorService's own constructor actually
// requires are imported - no ReservationEngineModeModule,
// MirrorCompensationModule, CartModule, or ProductsModule (CheckoutModule
// depends on none of them directly; PriceLockModule/InventoryModule/
// OrdersModule already satisfy their own internal needs for CartModule/
// ProductsModule through their own import graphs).
@Module({
  imports: [CheckoutAttemptModule, PriceLockModule, InventoryModule, OrdersModule, PaymentsModule],
  providers: [CheckoutCoordinatorService],
  exports: [CheckoutCoordinatorService],
})
export class CheckoutModule {}
