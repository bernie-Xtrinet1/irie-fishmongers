import { Module } from '@nestjs/common';

import { CartReservationSyncStateRepository } from './repositories/cart-reservation-sync-state.repository';

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review). Owns the
// CartReservationSyncState marker table - the durable record of desired
// Redis reservation state per (cartId, productId) pair. Declares no
// imports: PrismaService is available via PrismaModule's existing
// @Global() registration, matching MirrorCompensationModule's own
// precedent. DA.1B will add its recovery-worker service to this same
// module rather than creating a second one for the same table.
@Module({
  providers: [CartReservationSyncStateRepository],
  exports: [CartReservationSyncStateRepository],
})
export class CartReservationSyncModule {}
