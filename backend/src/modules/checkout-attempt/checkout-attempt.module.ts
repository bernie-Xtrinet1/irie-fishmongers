import { Module } from '@nestjs/common';

import { CheckoutAttemptRepository } from './repositories/checkout-attempt.repository';
import { CheckoutAttemptService } from './services/checkout-attempt.service';

// Phase 16A.0-A (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md).
// Additive and unwired - deliberately not imported by AppModule, OrdersModule,
// CartModule, InventoryModule, or any other production module in this unit.
// No controller exists here yet.
@Module({
  providers: [CheckoutAttemptRepository, CheckoutAttemptService],
  exports: [CheckoutAttemptRepository, CheckoutAttemptService],
})
export class CheckoutAttemptModule {}
