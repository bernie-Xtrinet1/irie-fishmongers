import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { ReservationFenceRepository } from './repositories/reservation-fence.repository';
import { ReservationFenceService } from './services/reservation-fence.service';
import { ReservationCapabilityService } from './services/reservation-capability.service';
import { CheckoutOperationRepository } from '../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../checkout-attempt/repositories/checkout-attempt.repository';
import { ReservationMutationAuthorityService } from './services/reservation-mutation-authority.service';
import { ReservationFencedExecutor } from './services/reservation-fenced-executor.service';
import { CheckoutSettlementRepository } from './repositories/checkout-settlement.repository';
import { CheckoutSettlementAuthorityService } from './services/checkout-settlement-authority.service';

// Inactive dispatcher infrastructure; not imported by production AppModule.
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [ReservationFenceRepository, ReservationFenceService, ReservationCapabilityService,
    CheckoutOperationRepository, CheckoutAttemptRepository, ReservationMutationAuthorityService, ReservationFencedExecutor,
    CheckoutSettlementRepository, CheckoutSettlementAuthorityService],
  exports: [ReservationFenceService, ReservationCapabilityService, ReservationMutationAuthorityService, ReservationFencedExecutor,
    ReservationFenceRepository, CheckoutSettlementRepository, CheckoutSettlementAuthorityService],
})
export class ReservationFenceModule {}
