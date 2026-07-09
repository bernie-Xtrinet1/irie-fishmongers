import { Module } from '@nestjs/common';

import { CatchesModule } from '../catches/catches.module';
import { ColdChainModule } from './cold-chain.module';
import { ComplianceOpsModule } from './compliance-ops.module';
import { QualityModule } from './quality.module';
import { RecallsModule } from './recalls.module';
import { SeafoodLotsModule } from './seafood-lots.module';
import { FoodSafetyEventsListener } from './services/food-safety-events.listener';

/**
 * Composition root only (Phase 11 amendment's Module Restructuring) - no
 * controllers/providers of its own beyond FoodSafetyEventsListener, which
 * needs visibility across submodules for its @OnEvent handlers. Every
 * controller route is unchanged; this is a pure internal reorganization of
 * a module that had grown to 6+ services in one flat file.
 */
@Module({
  imports: [SeafoodLotsModule, ColdChainModule, QualityModule, RecallsModule, ComplianceOpsModule, CatchesModule],
  providers: [FoodSafetyEventsListener],
})
export class FoodSafetyModule {}
