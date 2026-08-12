import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CartReservationSyncModule } from '../cart-reservation-sync/cart-reservation-sync.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductsModule } from '../products/products.module';
import { VendorsModule } from '../vendors/vendors.module';
import { CartController } from './controllers/cart.controller';
import { CartItemAddAttemptRepository } from './repositories/cart-item-add-attempt.repository';
import { CartRepository } from './repositories/cart.repository';
import { CartItemAddIdempotencyService } from './services/cart-item-add-idempotency.service';
import { CartReservationConvergenceService } from './services/cart-reservation-convergence.service';
import { CartService } from './services/cart.service';

@Module({
  imports: [AuthModule, ProductsModule, VendorsModule, InventoryModule, CartReservationSyncModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartRepository,
    CartItemAddAttemptRepository,
    CartItemAddIdempotencyService,
    CartReservationConvergenceService,
  ],
  exports: [CartRepository],
})
export class CartModule {}
