import { Module } from '@nestjs/common';

import { PrismaModule } from '../../database/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CartRepository } from '../cart/repositories/cart.repository';
import { PriceLockRepository } from '../price-lock/repositories/price-lock.repository';
import { ProductsRepository } from '../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import { CheckoutShadowReadService } from './services/checkout-shadow-read.service';
import { CheckoutShadowComparisonService } from './services/checkout-shadow-comparison.service';
import { CheckoutRolloutTelemetryService } from './services/checkout-rollout-telemetry.service';

// Deliberately absent from AppModule and every production caller. No controllers.
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    CartRepository,
    PriceLockRepository,
    ProductsRepository,
    ReservationEngineModeConfigRepository,
    CheckoutShadowReadService,
    CheckoutShadowComparisonService,
    CheckoutRolloutTelemetryService,
  ],
  exports: [CheckoutShadowComparisonService],
})
export class CheckoutShadowModule {}
