import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { ColdChainModule } from '../food-safety/cold-chain.module';
import { TelemetryIngestionController } from './controllers/telemetry-ingestion.controller';
import { TelemetryOperationsController } from './controllers/telemetry-operations.controller';
import { TelemetryGatewayAuthGuard } from './guards/telemetry-gateway-auth.guard';
import { TelemetryCredentialsService } from './services/telemetry-credentials.service';
import { TelemetryIngestionService } from './services/telemetry-ingestion.service';
import { TelemetryOperationsService } from './services/telemetry-operations.service';

@Module({
  imports: [PrismaModule, ColdChainModule],
  controllers: [TelemetryIngestionController, TelemetryOperationsController],
  providers: [
    TelemetryGatewayAuthGuard,
    TelemetryCredentialsService,
    TelemetryIngestionService,
    TelemetryOperationsService,
  ],
  exports: [
    TelemetryCredentialsService,
    TelemetryIngestionService,
    TelemetryOperationsService,
  ],
})
export class TelemetryModule {}
