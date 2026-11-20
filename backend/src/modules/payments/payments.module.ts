import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './controllers/payments.controller';
import { RefundReconciliationController } from './controllers/refund-reconciliation.controller';
import {
  ActiveAdministratorGuard,
  RefundReconciliationEndpointGateGuard,
} from './guards/refund-reconciliation-endpoint-gate.guard';
import { CashOnDeliveryAdapter } from './providers/cash-on-delivery.adapter';
import { WiPayAdapter } from './providers/wipay.adapter';
import { PaymentsRepository } from './repositories/payments.repository';
import { RefundAttemptsRepository } from './repositories/refund-attempts.repository';
import { RefundDualControlRepository } from './repositories/refund-dual-control.repository';
import { RefundEvidenceRepository } from './repositories/refund-evidence.repository';
import { RefundReconciliationRepository } from './repositories/refund-reconciliation.repository';
import { RefundRecoveryRepository } from './repositories/refund-recovery.repository';
import { RefundsRepository } from './repositories/refunds.repository';
import { PaymentReconciliationBatchService } from './services/payment-reconciliation-batch.service';
import { PaymentReconciliationSchedulerService } from './services/payment-reconciliation-scheduler.service';
import { PaymentReconciliationService } from './services/payment-reconciliation.service';
import { PaymentRecoveryService } from './services/payment-recovery.service';
import { PaymentsService } from './services/payments.service';
import { RefundDualControlReconciliationService } from './services/refund-dual-control-reconciliation.service';
import { RefundEvidenceProcessorService } from './services/refund-evidence-processor.service';
import { RefundOutboxService } from './services/refund-outbox.service';
import { RefundRecoveryInspectionService } from './services/refund-recovery-inspection.service';
import { RefundRecoveryService } from './services/refund-recovery.service';
import { RefundStatusReconciliationService } from './services/refund-status-reconciliation.service';
import { REFUND_RECONCILIATION_API_POLICY } from './types/refund-dual-control.types';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController, RefundReconciliationController],
  providers: [
    PaymentsService,
    PaymentRecoveryService,
    PaymentReconciliationService,
    PaymentReconciliationBatchService,
    PaymentReconciliationSchedulerService,
    PaymentsRepository,
    RefundsRepository,
    RefundAttemptsRepository,
    RefundDualControlRepository,
    RefundReconciliationRepository,
    RefundRecoveryRepository,
    RefundEvidenceRepository,
    RefundRecoveryInspectionService,
    RefundRecoveryService,
    RefundEvidenceProcessorService,
    RefundStatusReconciliationService,
    RefundDualControlReconciliationService,
    RefundReconciliationEndpointGateGuard,
    ActiveAdministratorGuard,
    { provide: REFUND_RECONCILIATION_API_POLICY, useValue: { enabled: false } },
    RefundOutboxService,
    WiPayAdapter,
    CashOnDeliveryAdapter,
  ],
  exports: [
    PaymentsService,
    PaymentRecoveryService,
    PaymentReconciliationService,
    PaymentReconciliationBatchService,
    PaymentsRepository,
    RefundAttemptsRepository,
    RefundDualControlRepository,
    RefundReconciliationRepository,
    RefundRecoveryRepository,
    RefundEvidenceRepository,
    RefundRecoveryInspectionService,
    RefundRecoveryService,
    RefundEvidenceProcessorService,
    RefundStatusReconciliationService,
    RefundDualControlReconciliationService,
    RefundOutboxService,
  ],
})
export class PaymentsModule {}
