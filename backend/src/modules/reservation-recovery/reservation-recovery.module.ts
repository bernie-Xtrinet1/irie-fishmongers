import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { ReservationEngineModeModule } from '../reservation-engine-mode/reservation-engine-mode.module';
import { ReservationRecoveryConvergenceService } from './services/reservation-recovery-convergence.service';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). Owns only
// ReservationRecoveryConvergenceService - the mode-aware write-routing/
// classification authority for recovery, deliberately separate from
// CheckoutReservationModule/ReservationGateway (admission-shaped, wrong
// semantics for recovery - see the service's own doc comment). Imports
// InventoryModule and ReservationEngineModeModule only, mirroring
// CheckoutReservationModule's own import shape - both confirmed leaves
// w.r.t. Cart/Order/Compensation, so importing this module from
// CartReservationSyncModule introduces no cycle. No CartRepository, no
// marker persistence, no claim fencing here - those remain entirely owned
// by CartReservationSyncModule itself.
@Module({
  imports: [InventoryModule, ReservationEngineModeModule],
  providers: [ReservationRecoveryConvergenceService],
  exports: [ReservationRecoveryConvergenceService],
})
export class ReservationRecoveryModule {}
