import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';
import { RedisModule } from '../../common/redis/redis.module';
import { RedisService } from '../../common/redis/redis.service';
import { ReservationFenceRepository } from './repositories/reservation-fence.repository';
import { ReservationFenceService } from './services/reservation-fence.service';
import { ReservationCapabilityService } from './services/reservation-capability.service';
import { CheckoutOperationRepository } from '../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../checkout-attempt/repositories/checkout-attempt.repository';
import { ReservationMutationAuthorityService } from './services/reservation-mutation-authority.service';
import { ReservationFencedExecutor } from './services/reservation-fenced-executor.service';
import { CheckoutSettlementRepository } from './repositories/checkout-settlement.repository';
import { CheckoutSettlementAuthorityService } from './services/checkout-settlement-authority.service';
import { OrdinaryInvalidationRepository } from './repositories/ordinary-invalidation.repository';
import { OrdinaryInvalidationService } from './services/ordinary-invalidation.service';
import { OrdinaryInvalidationPublicationService } from './services/ordinary-invalidation-publication.service';
import { OrdinaryRecoveryRegistryService } from './services/ordinary-recovery-registry.service';
import { OrdinaryMarkerBootstrapService } from './services/ordinary-marker-bootstrap.service';
import { OrdinaryInvalidationRecoveryService } from './services/ordinary-invalidation-recovery.service';
import { OrdinaryRecoverySweepWorker } from './workers/ordinary-recovery-sweep.worker';
import { ProductSuspectCrashEvidenceService } from './services/product-suspect-crash-evidence.service';
import { ProductSuspectClearanceService } from './services/product-suspect-clearance.service';

// Inactive dispatcher infrastructure; not imported by production AppModule.
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    ReservationFenceRepository,
    ReservationFenceService,
    ReservationCapabilityService,
    CheckoutOperationRepository,
    CheckoutAttemptRepository,
    ReservationMutationAuthorityService,
    ReservationFencedExecutor,
    CheckoutSettlementRepository,
    CheckoutSettlementAuthorityService,
    {
      provide: OrdinaryInvalidationRepository,
      useFactory: (prisma: PrismaService) => new OrdinaryInvalidationRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: OrdinaryInvalidationService,
      useFactory: (repo: OrdinaryInvalidationRepository, redis: RedisService) =>
        new OrdinaryInvalidationService(repo, redis),
      inject: [OrdinaryInvalidationRepository, RedisService],
    },
    {
      provide: OrdinaryInvalidationPublicationService,
      useFactory: (repo: OrdinaryInvalidationRepository) =>
        new OrdinaryInvalidationPublicationService(repo),
      inject: [OrdinaryInvalidationRepository],
    },
    OrdinaryRecoveryRegistryService,
    OrdinaryMarkerBootstrapService,
    OrdinaryInvalidationRecoveryService,
    OrdinaryRecoverySweepWorker,
    ProductSuspectCrashEvidenceService,
    ProductSuspectClearanceService,
  ],
  exports: [
    ReservationFenceService,
    ReservationCapabilityService,
    ReservationMutationAuthorityService,
    ReservationFencedExecutor,
    ReservationFenceRepository,
    CheckoutSettlementRepository,
    CheckoutSettlementAuthorityService,
    OrdinaryInvalidationRepository,
    OrdinaryInvalidationService,
    OrdinaryInvalidationPublicationService,
    OrdinaryRecoveryRegistryService,
    OrdinaryMarkerBootstrapService,
    OrdinaryInvalidationRecoveryService,
    OrdinaryRecoverySweepWorker,
    ProductSuspectCrashEvidenceService,
    ProductSuspectClearanceService,
  ],
})
export class ReservationFenceModule {}
