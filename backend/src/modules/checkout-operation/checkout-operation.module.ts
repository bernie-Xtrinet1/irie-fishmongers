import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { CartModule } from '../cart/cart.module';
import { PriceLockModule } from '../price-lock/price-lock.module';
import { CheckoutOperationRepository } from './repositories/checkout-operation.repository';
import { CheckoutOperationService } from './services/checkout-operation.service';

// Inactive, server-only preparation. Not imported by AppModule or controllers.
@Module({
  imports: [PrismaModule, CartModule, PriceLockModule],
  providers: [CheckoutOperationRepository, CheckoutOperationService],
  exports: [CheckoutOperationService],
})
export class CheckoutOperationModule {}
