import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RecallsController } from './controllers/recalls.controller';
import { RecallsRepository } from './repositories/recalls.repository';
import { SeafoodLotsModule } from './seafood-lots.module';
import { RecallsService } from './services/recalls.service';

/**
 * Split out of the former flat FoodSafetyModule (Phase 11 amendment's
 * Module Restructuring) - the recall lifecycle and, once built, the
 * waste-disposal tracking tied to it.
 */
@Module({
  imports: [AuthModule, SeafoodLotsModule],
  controllers: [RecallsController],
  providers: [RecallsService, RecallsRepository],
  exports: [RecallsRepository],
})
export class RecallsModule {}
