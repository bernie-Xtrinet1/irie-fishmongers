import { Module } from '@nestjs/common';

import { CompensationRepository } from './repositories/compensation.repository';
import { CompensationService } from './services/compensation.service';

// Phase 16A.0-C4.2 (see ADR-007). No imports needed - PrismaModule is
// @Global() (see database/prisma.module.ts) and PrismaService is already
// injected app-wide once AppModule imports it, matching every other
// repository-owning module in this codebase (none of them re-import
// PrismaModule either). Additive and unwired - not imported by
// CheckoutReservationModule, CartModule, AppModule, or any other
// production module.
@Module({
  providers: [CompensationRepository, CompensationService],
  exports: [CompensationService],
})
export class MirrorCompensationModule {}
