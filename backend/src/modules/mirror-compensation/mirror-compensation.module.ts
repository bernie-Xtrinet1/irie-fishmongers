import { Module } from '@nestjs/common';

import { CartModule } from '../cart/cart.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { CompensationRepository } from './repositories/compensation.repository';
import { CompensationBatchService } from './services/compensation-batch.service';
import { CompensationBlockedRecheckService } from './services/compensation-blocked-recheck.service';
import { CompensationReconciliationService } from './services/compensation-reconciliation.service';
import { CompensationSchedulerService } from './services/compensation-scheduler.service';
import { CompensationService } from './services/compensation.service';

// Phase 16A.0-C4.2/C4.3/C4.4/C4.5 (see ADR-007). PrismaModule is
// @Global() (see database/prisma.module.ts) and PrismaService is
// already injected app-wide once AppModule imports it, matching every
// other repository-owning module in this codebase - no PrismaModule
// import needed here. CartModule/InventoryModule/ReservationEngineModeModule
// are imported solely to satisfy CompensationReconciliationService/
// CompensationBlockedRecheckService's read-only desired-state/mirror-
// write/mode dependencies - CartRepository only (CartModule exports no
// CartService), never CartService itself. CompensationBatchService
// (C4.4) and CompensationSchedulerService (C4.5) need no additional
// imports of their own - the batch service only orchestrates the two
// already-provided single-row services plus CompensationRepository, and
// the scheduler only wraps the batch service; it is deliberately
// mode-independent (no ReservationEngineModeService dependency of any
// kind). CompensationRepository stays unexported - only the four
// services are reachable from outside this module, matching this
// codebase's narrow-export convention. CompensationSchedulerService is
// additionally NOT exported at all (no consumer needs it outside this
// module - @Cron activates it purely by being constructed as part of
// this module's own provider graph once AppModule imports this module).
// ScheduleModule.forRoot() is NOT imported here - it remains centrally
// owned by AppModule via the existing isSchedulerEnabled() gate.
@Module({
  imports: [CartModule, InventoryModule, ReservationEngineModeModule],
  providers: [
    CompensationRepository,
    CompensationService,
    CompensationReconciliationService,
    CompensationBlockedRecheckService,
    CompensationBatchService,
    CompensationSchedulerService,
  ],
  exports: [
    CompensationService,
    CompensationReconciliationService,
    CompensationBlockedRecheckService,
    CompensationBatchService,
  ],
})
export class MirrorCompensationModule {}
