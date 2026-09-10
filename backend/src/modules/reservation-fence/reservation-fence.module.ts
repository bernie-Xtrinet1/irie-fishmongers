import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { ReservationFenceRepository } from './repositories/reservation-fence.repository';
import { ReservationFenceService } from './services/reservation-fence.service';
import { ReservationCapabilityService } from './services/reservation-capability.service';
import { CheckoutOperationRepository } from '../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../checkout-attempt/repositories/checkout-attempt.repository';

// Intentionally not imported by AppModule or any admission/worker module.
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [ReservationFenceRepository, ReservationFenceService, ReservationCapabilityService,
    CheckoutOperationRepository, CheckoutAttemptRepository],
  exports: [ReservationFenceService, ReservationCapabilityService],
})
export class ReservationFenceModule {}
