import { Module } from '@nestjs/common';

import { CartMutationBarrierConfigRepository } from './repositories/cart-mutation-barrier-config.repository';
import { CartMutationBarrierService } from './services/cart-mutation-barrier.service';

// CART_SCOPED activation-boundary gate (see the gate design review). No
// imports - PrismaService is available via PrismaModule's existing
// @Global() registration, confirmed by every sibling module in this
// codebase that depends only on it. A confirmed leaf w.r.t. Cart/Order/
// Inventory/ReservationEngineMode: importing this module from CartModule
// and OrdersModule introduces no cycle.
@Module({
  providers: [CartMutationBarrierConfigRepository, CartMutationBarrierService],
  exports: [CartMutationBarrierConfigRepository, CartMutationBarrierService],
})
export class CartMutationBarrierModule {}
