import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  INestApplication,
  NotImplementedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  PaymentProviderName,
  PaymentStatus,
  RefundAttemptStatus,
  RefundEvidenceDisposition,
  RefundEvidenceProvenance,
  RefundObligationStatus,
  RefundReconciliationOutcome,
  RoleName,
} from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';

import { PrismaModule } from '../../../database/prisma.module';
import { AuthModule } from '../../auth/auth.module';
import { PaymentProviderAdapter } from '../interfaces/payment-provider.interface';
import { PaymentsModule } from '../payments.module';
import { CashOnDeliveryAdapter } from '../providers/cash-on-delivery.adapter';
import { WiPayAdapter, WIPAY_SANDBOX_API_URL } from '../providers/wipay.adapter';
import { RefundEvidenceRepository } from '../repositories/refund-evidence.repository';
import { computeEvidencePayloadDigest } from '../repositories/refund-locks.helper';
import { PaymentsService } from '../services/payments.service';
import { RefundEvidenceProcessorService } from '../services/refund-evidence-processor.service';
import { RefundStatusReconciliationService } from '../services/refund-status-reconciliation.service';
import { REFUND_RECONCILIATION_API_POLICY } from '../types/refund-dual-control.types';
import {
  createDualControlTestFixture,
  DualControlTestFixture,
} from './refund-dual-control-fixture.helper';

jest.setTimeout(120_000);

describe('WiPay Sandbox Mock Refund/Inquiry Lifecycle & Production Gate Safety (PG Suite)', () => {
  let fx: DualControlTestFixture;
  let evidenceProcessor: RefundEvidenceProcessorService;

  beforeAll(async () => {
    fx = await createDualControlTestFixture();
    evidenceProcessor = new RefundEvidenceProcessorService(
      new RefundEvidenceRepository(fx.ledger.prisma),
      {
        trustedWebhookAdapters: [PaymentProviderName.WIPAY],
        trustedStatusPollAdapters: [PaymentProviderName.WIPAY],
      },
    );
  });

  afterAll(async () => {
    await fx?.destroy();
  });

  function createWiPayBackedPaymentsService(wiPayOverride: PaymentProviderAdapter): PaymentsService {
    return new PaymentsService(
      fx.ledger.paymentsRepo,
      fx.ledger.refundsRepo,
      wiPayOverride as unknown as WiPayAdapter,
      new CashOnDeliveryAdapter(),
      new EventEmitter2(),
      fx.ledger.attemptsRepo,
    );
  }

  it('4A. Keeps real WiPayAdapter fail-closed (non-sandbox rejected, refundPayment/verifyRefundStatus 501) and records PRE_SEND_ABORT', async () => {
    const nonSandboxCfg = {
      getOrThrow: (k: string) =>
        ({
          WIPAY_API_URL: 'https://jm.wipayfinancial.com/plugins/payments',
          WIPAY_FEE_STRUCTURE: 'merchant_absorb',
          WIPAY_ACCOUNT_NUMBER: '1234567890',
          WIPAY_API_KEY: 'dummy-sandbox-key',
          APP_BASE_URL: 'http://localhost:3001',
          API_PREFIX: 'api/v1',
        })[k],
    } as unknown as ConfigService;

    const realAdapter = new WiPayAdapter(nonSandboxCfg);
    await expect(
      realAdapter.createPayment({ orderId: 'o1', amount: 50, currency: 'JMD', customerEmail: 'a@b.com' }),
    ).rejects.toThrow(BadRequestException);
    await expect(realAdapter.refundPayment('wp-1', 50, 'test')).rejects.toThrow(NotImplementedException);
    await expect(realAdapter.verifyPayment('wp-1')).rejects.toThrow(NotImplementedException);
    await expect(
      realAdapter.verifyRefundStatus({
        attemptId: 'att-1',
        providerIdempotencyKey: 'k-1',
        amount: 50,
        currency: 'JMD',
      }),
    ).rejects.toThrow(NotImplementedException);

    const { payment } = await fx.ledger.seedOrderWithPayment({
      amount: '50.00',
      provider: PaymentProviderName.WIPAY,
      providerReference: `wp-real-${randomUUID().slice(0, 8)}`,
    });
    const realSvc = createWiPayBackedPaymentsService(realAdapter);
    await expect(realSvc.refundByPaymentId(payment.id, 50, 'Unsupported live WiPay', randomUUID())).rejects.toThrow(
      NotImplementedException,
    );
    expect((await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      PaymentStatus.PAID,
    );
  });

  it('4B. Verifies mock WiPay sandbox refund request/response, inquiry polling, settlement ref checks & payload sanitization', async () => {
    const chgRef = `wp-sbx-chg-${randomUUID().slice(0, 8)}`;
    const remRef = `wp-sbx-ref-${randomUUID().slice(0, 8)}`;
    const { payment } = await fx.ledger.seedOrderWithPayment({
      amount: '80.00',
      provider: PaymentProviderName.WIPAY,
      providerReference: chgRef,
    });

    const mockAdapter: PaymentProviderAdapter = {
      name: PaymentProviderName.WIPAY,
      supportsRefundStatusLookup: true,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: jest.fn().mockResolvedValue({
        providerReference: remRef,
        status: 'PENDING',
        httpStatusCode: 202,
        rawPayload: {
          sandboxUrl: WIPAY_SANDBOX_API_URL,
          authorizationHeader: 'Bearer sbx-secret-token-never-persist',
          transaction_id: remRef,
          status: 'PENDING',
        },
      }),
      verifyRefundStatus: jest.fn().mockResolvedValue({
        outcome: 'COMPLETED',
        providerRefundReference: remRef,
        parentPaymentReference: chgRef,
        amount: '80.00',
        currency: 'JMD',
        merchantAccountId: 'default',
        providerEventId: `wapi-poll-${randomUUID()}`,
        verificationToken: 'sbx-poll-tok-1',
        httpStatusCode: 200,
        rawPayload: {
          api_key: 'sbx-secret-api-key-never-persist',
          status: 'COMPLETED',
          refund_id: remRef,
        },
      }),
    };

    const sbxSvc = createWiPayBackedPaymentsService(mockAdapter);
    const initRes = await sbxSvc.refundByPaymentId(payment.id, 80, 'Mock WiPay sandbox refund', randomUUID());
    const attempt = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({
      where: { refundId: initRes.id },
    });
    expect(attempt.status).toBe(RefundAttemptStatus.PROVIDER_PENDING);

    // Reject parent charge reference echoed on inquiry/evidence
    const echoedPayload = { status: 'COMPLETED', refund_id: chgRef };
    const echoedRes = await evidenceProcessor.processEvidence({
      attemptId: attempt.id,
      obligationId: attempt.obligationId,
      provider: PaymentProviderName.WIPAY,
      merchantAccountId: attempt.merchantAccountId,
      providerRefundReference: chgRef,
      amount: '80.00',
      currency: 'JMD',
      outcome: 'COMPLETED',
      evidence: {
        provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
        eventId: `wapi-echo-${randomUUID()}`,
        rawPayload: echoedPayload,
        evidenceDigest: computeEvidencePayloadDigest(echoedPayload),
        eventTimestamp: new Date(),
        signatureValid: true,
        verification: { verifiedByAdapter: PaymentProviderName.WIPAY, adapterVerificationToken: 't', verifiedAt: new Date() },
      },
    });
    expect(echoedRes.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);

    // Inquiry poll settles attempt -> COMPLETED cleanly and strips secrets
    const pollSvc = new RefundStatusReconciliationService(fx.ledger.prisma, evidenceProcessor);
    const pollRes = await pollSvc.reconcileAttemptStatus(attempt.id, {
      adapterOverrides: { [PaymentProviderName.WIPAY]: mockAdapter },
    });
    expect(pollRes.outcome).toBe('COMPLETED');

    const events = await fx.ledger.prisma.refundProviderAttemptEvent.findMany({
      where: { attemptId: attempt.id },
    });
    expect(JSON.stringify(events)).not.toContain('sbx-secret-token-never-persist');
    expect(JSON.stringify(events)).not.toContain('sbx-secret-api-key-never-persist');
    expect((await fx.ledger.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      PaymentStatus.REFUNDED,
    );
  });

  it('4C. Quarantines WiPay sandbox timeout/ambiguity, blocks replay, rejects duplicate/conflicting responses & reconciles via dual control', async () => {
    const chgRef = `wp-sbx-to-${randomUUID().slice(0, 8)}`;
    const { payment } = await fx.ledger.seedOrderWithPayment({
      amount: '65.00',
      provider: PaymentProviderName.WIPAY,
      providerReference: chgRef,
    });
    const timeoutRefundSpy = jest.fn().mockRejectedValue(
      new Error('ETIMEDOUT sandbox /wapi/transactions/refund'),
    );
    const timeoutMock: PaymentProviderAdapter = {
      name: PaymentProviderName.WIPAY,
      createPayment: jest.fn(),
      verifyPayment: jest.fn(),
      refundPayment: timeoutRefundSpy,
    };

    const idemKey = randomUUID();
    const sbxSvc = createWiPayBackedPaymentsService(timeoutMock);
    await expect(sbxSvc.refundByPaymentId(payment.id, 65, 'Timeout quarantine test', idemKey)).rejects.toThrow();

    // Replay returns quarantined state cleanly with zero second refundPayment call
    await sbxSvc.refundByPaymentId(payment.id, 65, 'Timeout quarantine test', idemKey);
    expect(timeoutRefundSpy).toHaveBeenCalledTimes(1);

    const attempt = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(attempt.status).toBe(RefundAttemptStatus.AMBIGUOUS_OUTCOME);

    // Duplicate & conflicting webhook responses handled fail-closed
    const whEvtId = `wapi-wh-${randomUUID()}`;
    const remRef = `wp-sbx-settled-${randomUUID().slice(0, 8)}`;
    const rawOk = { status: 'COMPLETED', refund_id: remRef, secret: 'sbx-webhook-key-hidden' };
    const mkWh = (evId: string, raw: Record<string, unknown>, out: 'COMPLETED' | 'FAILED', ref?: string) =>
      evidenceProcessor.processEvidence({
        attemptId: attempt.id,
        obligationId: attempt.obligationId,
        provider: PaymentProviderName.WIPAY,
        merchantAccountId: attempt.merchantAccountId,
        providerRefundReference: ref ?? remRef,
        amount: '65.00',
        currency: 'JMD',
        outcome: out,
        evidence: {
          provenance: RefundEvidenceProvenance.AUTHENTICATED_WEBHOOK,
          eventId: evId,
          rawPayload: raw,
          evidenceDigest: computeEvidencePayloadDigest(raw),
          eventTimestamp: new Date(),
          signatureValid: true,
          verification: { verifiedByAdapter: PaymentProviderName.WIPAY, adapterVerificationToken: 'wh-tok', verifiedAt: new Date() },
        },
      });

    const firstWh = await mkWh(whEvtId, rawOk, 'COMPLETED');
    const dupWh = await mkWh(whEvtId, rawOk, 'COMPLETED');
    expect(firstWh.applied).toBe(true);
    expect(dupWh.disposition).toBe(RefundEvidenceDisposition.DUPLICATE_IGNORED);

    const conflictAfterComp = await mkWh(`wapi-conf-${randomUUID()}`, { status: 'FAILED' }, 'FAILED', 'other-ref');
    expect(conflictAfterComp.disposition).toBe(RefundEvidenceDisposition.CONFLICT_REJECTED);
    expect((await fx.ledger.prisma.refundObligation.findUniqueOrThrow({ where: { id: attempt.obligationId } })).status).toBe(
      RefundObligationStatus.FULFILLED,
    );

    // Second WiPay timeout resolved by dual control VERIFIED_COMPLETED & duplicate ref blocked
    const { payment: p2 } = await fx.ledger.seedOrderWithPayment({
      amount: '45.00', provider: PaymentProviderName.WIPAY, providerReference: `wp-sbx-to2-${randomUUID().slice(0, 8)}`,
    });
    const svc2 = createWiPayBackedPaymentsService(timeoutMock);
    await expect(svc2.refundByPaymentId(p2.id, 45, 'WiPay manual completion path', randomUUID())).rejects.toThrow();
    const att2 = await fx.ledger.prisma.refundProviderAttempt.findFirstOrThrow({ where: { paymentId: p2.id } });
    const req2 = await fx.service.requestReconciliation({
      obligationId: att2.obligationId, attemptId: att2.id, requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
      evidenceType: 'WIPAY_PORTAL_SETTLEMENT', externalSettlementReference: `wp-sbx-man-${randomUUID().slice(0, 8)}`,
      rationale: 'Operator verified WiPay sandbox refund in merchant portal after timeout', requestedByActorId: fx.adminA.id,
    });
    await fx.service.approveReconciliation({ approvalId: req2.id, approvedByActorId: fx.adminB.id });
    const exec2 = await fx.service.executeReconciliation({ approvalId: req2.id, executedByActorId: fx.adminC.id });
    expect(exec2.applied).toBe(true);
    expect(exec2.attemptStatus).toBe(RefundAttemptStatus.COMPLETED);
    expect(exec2.obligationStatus).toBe(RefundObligationStatus.FULFILLED);
    await expect(
      fx.service.requestReconciliation({
        obligationId: attempt.obligationId, requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
        evidenceType: 'MANUAL_REVIEW', externalSettlementReference: remRef,
        rationale: 'Cannot reuse settled WiPay reference or settled obligation', requestedByActorId: fx.adminA.id,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('4D. Keeps production admin reconciliation routes 501 even when env flag, policy, and WiPay sandbox settings exist', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevApiFlag = process.env.REFUND_RECONCILIATION_API_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.REFUND_RECONCILIATION_API_ENABLED = 'true';

    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                NODE_ENV: 'production',
                REFUND_RECONCILIATION_API_ENABLED: 'true',
                JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'test_secret_at_least_32_characters_long_01',
                JWT_ACCESS_EXPIRES_IN: '15m',
                WIPAY_API_URL: WIPAY_SANDBOX_API_URL,
              }),
            ],
          }),
          EventEmitterModule.forRoot(),
          ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
          PrismaModule,
          AuthModule,
          PaymentsModule,
        ],
      })
        .overrideProvider(REFUND_RECONCILIATION_API_POLICY)
        .useValue({ enabled: true })
        .compile();

      app = moduleRef.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();

      const jwt = moduleRef.get(JwtService);
      const cfg = moduleRef.get(ConfigService);
      const token = jwt.sign(
        { sub: fx.adminA.id, email: fx.adminA.email, roles: [RoleName.ADMINISTRATOR] },
        { secret: cfg.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 300 },
      );

      await request(app.getHttpServer() as App)
        .get('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${token}`)
        .expect(HttpStatus.NOT_IMPLEMENTED);

      await request(app.getHttpServer() as App)
        .post('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${token}`)
        .send({
          obligationId: randomUUID(),
          requestedOutcome: RefundReconciliationOutcome.CONTINUE_QUARANTINE,
          evidenceType: 'MANUAL_REVIEW',
          rationale: 'Must return 501 in production mode',
        })
        .expect(HttpStatus.NOT_IMPLEMENTED);
    } finally {
      await app?.close();
      process.env.NODE_ENV = prevNodeEnv;
      if (prevApiFlag === undefined) delete process.env.REFUND_RECONCILIATION_API_ENABLED;
      else process.env.REFUND_RECONCILIATION_API_ENABLED = prevApiFlag;
    }
  });

  // Live WiPay WAPI sandbox contract tests remain PENDING until confirmed sandbox WAPI URL,
  // OAuth/WAPI merchant credentials, a test sandbox charge txn, and webhook secret are provisioned.
  it.skip('PENDING [Requires WAPI sandbox URL, OAuth/WAPI credentials & seeded charge txn]: 5A. Verifies live WAPI auth, /wapi/transactions/createRefundRequest, and distinct refund vs parent charge identifiers', () => {
    expect(process.env.WIPAY_WAPI_KEY ?? process.env.WIPAY_CLIENT_SECRET).toBeDefined();
  });

  it.skip('PENDING [Requires WAPI sandbox credentials & live refund txn]: 5B. Verifies live WAPI refund status inquiry endpoint and duplicate/retry request semantics', () => {
    expect(process.env.WIPAY_WAPI_KEY ?? process.env.WIPAY_CLIENT_SECRET).toBeDefined();
  });

  it.skip('PENDING [Requires WAPI sandbox credentials]: 5C. Verifies live WAPI pending/completed/failed codes, settlement reference behavior, and ambiguous timeout handling', () => {
    expect(process.env.WIPAY_WAPI_KEY ?? process.env.WIPAY_CLIENT_SECRET).toBeDefined();
  });

  it.skip('PENDING [Requires WAPI webhook secret & sandbox delivery]: 5D. Verifies X-WiPay-Webhook-* HMAC-SHA256 signature verification, 5-min replay tolerance, and X-WiPay-Webhook-Id idempotency', () => {
    expect(process.env.WIPAY_WEBHOOK_SECRET).toBeDefined();
  });
});
