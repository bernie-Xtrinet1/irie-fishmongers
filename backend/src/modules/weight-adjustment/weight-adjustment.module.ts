import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';

// Repositories
import { CustomerWeightApprovalChallengeRepository } from './repositories/customer-weight-approval-challenge.repository';
import { CustomerWeightConsentRepository } from './repositories/customer-weight-consent.repository';
import { SeafoodOrderWeightAdjustmentRepository } from './repositories/seafood-order-weight-adjustment.repository';
import { SeafoodPreparationFulfillmentEventRepository } from './repositories/seafood-preparation-fulfillment-event.repository';
import { SeafoodWeightMeasurementEventRepository } from './repositories/seafood-weight-measurement-event.repository';
import { WeightFinancialObligationRepository } from './repositories/weight-financial-obligation.repository';

// Services
import { CustomerWeightApprovalCoordinationService } from './services/customer-weight-approval-coordination.service';
import { SeafoodPreparationFulfillmentService } from './services/seafood-preparation-fulfillment.service';
import { SeafoodWeightMeasurementService } from './services/seafood-weight-measurement.service';
import { WeightAdjustmentApprovalTokenService } from './services/weight-adjustment-approval-token.service';
import { WeightAdjustmentReleaseReadinessService } from './services/weight-adjustment-release-readiness.service';
import { WeightAdjustmentSafetyGateService } from './services/weight-adjustment-safety-gate.service';
import { WeightAdjustmentSettlementService } from './services/weight-adjustment-settlement.service';
import { WeightAdjustmentSnapshotInitializationService } from './services/weight-adjustment-snapshot-initialization.service';

/**
 * Phase 16D Weight Adjustment Subsystem Module
 *
 * Encapsulates the complete seafood weight adjustment, customer approval challenge,
 * preparation fulfillment, financial settlement, and physical release readiness services.
 *
 * Operational Containment:
 * - This module is completely self-contained and imports only PrismaModule.
 * - Zero controllers: No public HTTP endpoints or routes are exposed.
 * - Zero cron jobs: No timer sweeps or scheduled tasks are scheduled.
 * - Zero event subscribers: No event listeners are hooked to the global event emitter.
 * - Dormant by default: Not imported into AppModule or any active runtime controller.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    // Repositories
    CustomerWeightConsentRepository,
    SeafoodOrderWeightAdjustmentRepository,
    SeafoodPreparationFulfillmentEventRepository,
    SeafoodWeightMeasurementEventRepository,
    WeightFinancialObligationRepository,
    {
      provide: CustomerWeightApprovalChallengeRepository,
      useFactory: (prisma: PrismaService) => new CustomerWeightApprovalChallengeRepository(prisma),
      inject: [PrismaService],
    },

    // Services
    WeightAdjustmentSafetyGateService,
    {
      provide: WeightAdjustmentApprovalTokenService,
      useFactory: () => new WeightAdjustmentApprovalTokenService(),
    },
    WeightAdjustmentSnapshotInitializationService,
    SeafoodWeightMeasurementService,
    SeafoodPreparationFulfillmentService,
    CustomerWeightApprovalCoordinationService,
    WeightAdjustmentSettlementService,
    WeightAdjustmentReleaseReadinessService,
  ],
  exports: [
    WeightAdjustmentSnapshotInitializationService,
    SeafoodWeightMeasurementService,
    SeafoodPreparationFulfillmentService,
    CustomerWeightApprovalCoordinationService,
    WeightAdjustmentSettlementService,
    WeightAdjustmentReleaseReadinessService,
  ],
})
export class WeightAdjustmentModule {}
