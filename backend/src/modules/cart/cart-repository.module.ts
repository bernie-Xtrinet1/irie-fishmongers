import { Module } from '@nestjs/common';

import { CartRepository } from './repositories/cart.repository';

// Phase 16A.0-DA, Unit DA.4 (see the DA.4 frozen plan). Hoists CartRepository
// out of CartModule so it can be shared with MirrorCompensationModule without
// creating a cycle: CheckoutReservationModule -> MirrorCompensationModule ->
// CartModule -> CheckoutReservationModule. CartRepository has exactly one
// runtime dependency (the global PrismaService), so this module needs no
// imports of its own - a single provider, a single exported instance, no
// duplicate registration anywhere in the graph. CartModule re-exports
// CartRepository via this module rather than declaring it directly; every
// other existing consumer (OrdersModule, PriceLockModule, importing
// CartModule) is unaffected - the DI token and its resolved instance are
// unchanged, only which module physically provides it.
//
// CartReservationSyncModule's own separate, deliberate CartRepository
// duplication (see its module comment) predates this unit and is untouched -
// that duplication solves an identical cycle (CartModule ->
// CartReservationSyncModule -> CartModule) that already existed before DA.4
// and is out of this unit's scope.
@Module({
  providers: [CartRepository],
  exports: [CartRepository],
})
export class CartRepositoryModule {}
