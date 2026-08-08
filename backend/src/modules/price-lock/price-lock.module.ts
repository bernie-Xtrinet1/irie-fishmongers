import { Module } from '@nestjs/common';

import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';
import { PriceLockRepository } from './repositories/price-lock.repository';
import { PriceLockService } from './services/price-lock.service';

// Phase 16A.0-B (see
// docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 7). Additive and unwired - not imported by AppModule,
// CartModule, OrdersModule, CheckoutAttemptModule, or any other
// production module.
@Module({
  imports: [CartModule, ProductsModule],
  providers: [PriceLockService, PriceLockRepository],
  exports: [PriceLockService, PriceLockRepository],
})
export class PriceLockModule {}
