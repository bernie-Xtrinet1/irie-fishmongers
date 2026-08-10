import { Module } from '@nestjs/common';

import { CartModule } from '../cart/cart.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { CompensationRepository } from './repositories/compensation.repository';
import { CompensationBatchService } from './services/compensation-batch.service';
import { CompensationBlockedRecheckService } from './services/compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './services/compensation-reconciliation.service';
import { CompensationService } from './services/compensation.service';

// Phase 16A.0-C4.2/C4.3/C4.4 (see ADR-007). PrismaModule is @Global()
// (see database/prisma.module.ts) and PrismaService is already injected
// app-wide once AppModule imports it, matching every other repository-
// owning module in this codebase - no PrismaModule import needed here.
// CartModule/InventoryModule/ReservationEngineModeModule are imported
// solely to satisfy CompensationReconciliationService/
// CompensationBlockedRecheckService's read-only desired-state/mirror-
// write/mode dependencies - CartRepository only (CartModule exports no
// CartService), never CartService itself. CompensationBatchService
// (C4.4) needs no additional imports of its own - it only orchestrates
// the two already-provided single-row services plus CompensationRepository.
// CompensationRepository stays unexported - only the four services are
// reachable from outside this module, matching this codebase's narrow-
// export convention. Additive and unwired - not imported by
// CheckoutReservationModule, AppModule, or any other production module.
// CompensationBatchService exposes only an invokable runBatch() - no
// @Cron, no setInterval, no scheduler wiring exists anywhere in this
// module (C4.5's scope, not C4.4's).
@Module({
  imports: [CartModule, InventoryModule, ReservationEngineModeModule],
  providers: [
    CompensationRepository,
    CompensationService,
    CompensationReconciliationService,
    CompensationBlockedRecheckService,
    CompensationBatchService,
  ],
  exports: [
    CompensationService,
    CompensationReconciliationService,
    CompensationBlockedRecheckService,
    CompensationBatchService,
  ],
})
export class MirrorCompensationModule {}
