import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CartReservationSyncModule } from '../cart-reservation-sync/cart-reservation-sync.module';
import { CheckoutReservationModule } from '../checkout-reservation/checkout-reservation.module';
import { ProductsModule } from '../products/products.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CartRepositoryModule } from './cart-repository.module';
import { CartController } from './controllers/cart.controller';
import { CartItemAddAttemptRepository } from './repositories/cart-item-add-attempt.repository';
import { CartItemAddIdempotencyService } from './services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from './services/cart-reservation-convergence.service';
import { CartService } from './services/cart.service';

// Phase 16A.0-DA, Unit DA.3 (see the DA.3 frozen plan). CheckoutReservationModule
// replaces the direct InventoryModule import - CartService/
// CartReservationConvergenceService no longer depend on
// InventoryReservationsService at all, only on the RESERVATION_GATEWAY
// token CheckoutReservationModule exports (InventoryModule is still
// pulled in transitively, via CheckoutReservationModule's own imports).
// One-way edge, no cycle: CheckoutReservationModule imports
// InventoryModule/ReservationEngineModeModule/MirrorCompensationModule
// (as of DA.4), none of which import CartModule.
//
// Phase 16A.0-DA, Unit DA.4: CartRepository is no longer declared as this
// module's own provider - it now comes from CartRepositoryModule, which
// MirrorCompensationModule also imports (via CheckoutReservationModule).
// Re-exporting CartRepositoryModule here keeps CartRepository visible to
// every existing external consumer (OrdersModule, PriceLockModule) exactly
// as before - same token, same singleton instance, one provider
// registration in the whole graph.
@Module({
  imports: [
    AuthModule,
    ProductsModule,
    VendorsModule,
    CheckoutReservationModule,
    CartReservationSyncModule,
    CartRepositoryModule,
  ],
  controllers: [CartController],
  providers: [
    CartService,
    CartItemAddAttemptRepository,
    CartItemAddIdempotencyService,
    CartReservationConvergenceService,
  ],
  exports: [CartRepositoryModule],
})
export class CartModule {}
