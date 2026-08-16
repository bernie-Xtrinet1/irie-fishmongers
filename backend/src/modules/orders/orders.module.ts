import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { CartMutationBarrierModule } from '../cart-mutation-barrier/cart-mutation-barrier.module';
import { CartReservationSyncModule } from '../cart-reservation-sync/cart-reservation-sync.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProductsModule } from '../products/products.module';
import { VendorTiersModule } from '../vendor-tiers/vendor-tiers.module';
import { VendorsModule } from '../vendors/vendors.module';
import { OrdersController } from './controllers/orders.controller';
import { VendorOrdersController } from './controllers/vendor-orders.controller';
import { OrdersRepository } from './repositories/orders.repository';
import { VendorOrdersRepository } from './repositories/vendor-orders.repository';
import { OrdersService } from './services/orders.service';
import { VendorOrdersService } from './services/vendor-orders.service';

// CART_SCOPED activation-boundary gate (see the gate design review).
// CartMutationBarrierModule is a confirmed leaf - importing it here
// introduces no cycle. OrdersService.createOrderInTransaction acquires the
// barrier's shared advisory lock as the first statement of its own
// existing, externally-owned transaction.
@Module({
  imports: [
    AuthModule,
    CartModule,
    CartReservationSyncModule,
    ProductsModule,
    VendorsModule,
    PaymentsModule,
    VendorTiersModule,
    InventoryModule,
    CartMutationBarrierModule,
  ],
  controllers: [OrdersController, VendorOrdersController],
  providers: [
    OrdersService,
    VendorOrdersService,
    OrdersRepository,
    VendorOrdersRepository,
  ],
  // OrdersService added to exports in Phase 16A.0-D, Unit D.4: the first
  // consumer outside this module (CheckoutModule) needs it through Nest DI.
  // Still owned and instantiated only here.
  exports: [OrdersRepository, VendorOrdersRepository, OrdersService],
})
export class OrdersModule {}
