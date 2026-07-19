import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './controllers/payments.controller';
import { CashOnDeliveryAdapter } from './providers/cash-on-delivery.adapter';
import { WiPayAdapter } from './providers/wipay.adapter';
import { PaymentsRepository } from './repositories/payments.repository';
import { RefundsRepository } from './repositories/refunds.repository';
import { PaymentsService } from './services/payments.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    RefundsRepository,
    WiPayAdapter,
    CashOnDeliveryAdapter,
  ],
  exports: [PaymentsService, PaymentsRepository],
})
export class PaymentsModule {}
