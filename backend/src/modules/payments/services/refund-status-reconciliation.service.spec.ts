import { NotImplementedException } from '@nestjs/common';
import { PaymentProviderName, RefundAttemptStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { WiPayAdapter } from '../providers/wipay.adapter';
import { RefundEvidenceProcessorService } from './refund-evidence-processor.service';
import { RefundStatusReconciliationService } from './refund-status-reconciliation.service';

describe('RefundStatusReconciliationService (Unit)', () => {
  it('fails closed with NotImplementedException for WiPay without acquiring poll lock', async () => {
    const updateMany = jest.fn();
    const processEvidence = jest.fn();
    const prisma = {
      refundProviderAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'att-wipay-1',
          provider: PaymentProviderName.WIPAY,
          status: RefundAttemptStatus.AMBIGUOUS_OUTCOME,
          version: 1,
          payment: { providerReference: 'wipay-chg-1' },
        }),
        updateMany,
      },
    } as unknown as PrismaService;

    const evidenceProcessor = { processEvidence } as unknown as RefundEvidenceProcessorService;

    const wiPayAdapter = new WiPayAdapter(null as never);
    const service = new RefundStatusReconciliationService(
      prisma,
      evidenceProcessor,
      wiPayAdapter,
    );

    await expect(service.reconcileAttemptStatus('att-wipay-1')).rejects.toThrow(
      NotImplementedException,
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(processEvidence).not.toHaveBeenCalled();
  });

  it('skips attempts that are not in PROVIDER_PENDING or AMBIGUOUS_OUTCOME', async () => {
    const updateMany = jest.fn();
    const prisma = {
      refundProviderAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'att-done-1',
          provider: PaymentProviderName.CASH_ON_DELIVERY,
          status: RefundAttemptStatus.COMPLETED,
          version: 2,
          payment: { providerReference: 'cod-chg-1' },
        }),
        updateMany,
      },
    } as unknown as PrismaService;

    const evidenceProcessor = {
      processEvidence: jest.fn(),
    } as unknown as RefundEvidenceProcessorService;

    const service = new RefundStatusReconciliationService(prisma, evidenceProcessor);
    const result = await service.reconcileAttemptStatus('att-done-1');

    expect(result.outcome).toBe('SKIPPED_LEASED_OR_INELIGIBLE');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
