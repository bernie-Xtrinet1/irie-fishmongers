import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './controllers/inventory.controller';
import { InventoryEventsRepository } from './repositories/inventory-events.repository';
import { InventoryReconciliationService } from './services/inventory-reconciliation.service';
import { InventoryReservationsService } from './services/inventory-reservations.service';

// Deliberately does NOT import ProductsModule, CartModule, or OrdersModule -
// all three import *this* module instead, so the dependency graph only ever
// points one way. See the Phase 7 plan's "Avoiding circular module
// dependencies" section.
@Module({
  imports: [AuthModule],
  controllers: [InventoryController],
  providers: [InventoryReservationsService, InventoryReconciliationService, InventoryEventsRepository],
  exports: [InventoryReservationsService, InventoryEventsRepository],
})
export class InventoryModule {}
