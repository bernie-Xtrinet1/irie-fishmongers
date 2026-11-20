import { randomUUID } from 'crypto';

import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  RefundAttemptStatus,
  RefundObligationStatus,
  RefundReconciliationApprovalStatus,
  RefundReconciliationOutcome,
  RoleName,
  User,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';

import { PrismaModule } from '../../../database/prisma.module';
import { AuthModule } from '../../auth/auth.module';
import {
  RefundApprovalResponseEntity,
  RefundObligationInspectionResponseEntity,
  RefundReconciliationExecutionResponseEntity,
} from '../entities/refund-reconciliation-response.entity';
import { PaymentsModule } from '../payments.module';
import { REFUND_RECONCILIATION_API_POLICY } from '../types/refund-dual-control.types';
import {
  createDualControlTestFixture,
  DualControlTestFixture,
} from './refund-dual-control-fixture.helper';

jest.setTimeout(120_000);

describe('Dual-Control Refund Reconciliation Direct SQL Bypass & HTTP Security E2E (PG Suite)', () => {
  let fx: DualControlTestFixture;

  beforeAll(async () => {
    fx = await createDualControlTestFixture();
  });

  afterAll(async () => {
    await fx?.destroy();
  });

  function signUserToken(
    jwtService: JwtService,
    configService: ConfigService,
    user: User,
    roles: RoleName[],
  ): string {
    return jwtService.sign(
      { sub: user.id, email: user.email, roles },
      { secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 300 },
    );
  }

  async function buildHttpTestApp(policyEnabled: boolean): Promise<{
    app: INestApplication;
    jwtService: JwtService;
    configService: ConfigService;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        PrismaModule,
        AuthModule,
        PaymentsModule,
      ],
    })
      .overrideProvider(REFUND_RECONCILIATION_API_POLICY)
      .useValue({ enabled: policyEnabled })
      .compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    return {
      app,
      jwtService: moduleRef.get(JwtService),
      configService: moduleRef.get(ConfigService),
    };
  }

  it('15. Rejects direct SQL bypass attempts against approvals, approval_events, and #59-#69 financial tables', async () => {
    const c = await fx.seedQuarantinedCase({ amount: '52.00' });
    const req = await fx.service.requestReconciliation({
      obligationId: c.obligationId,
      attemptId: c.attemptId,
      requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
      evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
      rationale: 'Direct SQL bypass resistance check',
      requestedByActorId: fx.adminA.id,
    });
    const reqEvent = await fx.ledger.prisma.refundReconciliationApprovalEvent.findFirstOrThrow({
      where: { approvalId: req.id },
    });

    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_reconciliation_approvals"
        SET "status" = 'APPROVED', "approvedByActorId" = '${fx.adminA.id}', "approvedAt" = NOW(), "authorizationRevision" = 2
        WHERE "id" = '${req.id}'
      `),
    ).rejects.toThrow();

    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_reconciliation_approvals"
        SET "status" = 'APPLIED', "appliedAt" = NOW(), "authorizationRevision" = 2
        WHERE "id" = '${req.id}'
      `),
    ).rejects.toThrow();

    await expect(
      fx.ledger.prisma.$executeRawUnsafe(`
        UPDATE "refund_reconciliation_approval_events"
        SET "actorId" = '${fx.adminB.id}'
        WHERE "id" = '${reqEvent.id}'
      `),
    ).rejects.toThrow();
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(
        `DELETE FROM "refund_reconciliation_approval_events" WHERE "id" = '${reqEvent.id}'`,
      ),
    ).rejects.toThrow();

    await expect(
      fx.ledger.prisma.$executeRawUnsafe(
        `UPDATE "refund_provider_attempts" SET "status" = 'COMPLETED' WHERE "id" = '${c.attemptId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      fx.ledger.prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "status" = 'COMPLETED' WHERE "id" = '${c.refundId}'`,
      ),
    ).rejects.toThrow();
  });

  it('16. Enforces endpoint gate (disabled=501), JWT/role/active-admin auth, anti-spoofing DTOs, sanitized output & HTTP dual control', async () => {
    const prevApiFlag = process.env.REFUND_RECONCILIATION_API_ENABLED;
    delete process.env.REFUND_RECONCILIATION_API_ENABLED;

    const disabledHarness = await buildHttpTestApp(false);
    const adminATokenDisabled = signUserToken(
      disabledHarness.jwtService,
      disabledHarness.configService,
      fx.adminA,
      [RoleName.ADMINISTRATOR],
    );
    await request(disabledHarness.app.getHttpServer() as App)
      .get('/admin/refund-reconciliation/approvals')
      .set('Authorization', `Bearer ${adminATokenDisabled}`)
      .expect(HttpStatus.NOT_IMPLEMENTED);
    await disabledHarness.app.close();

    const enabledHarness = await buildHttpTestApp(true);
    try {
      const server = enabledHarness.app.getHttpServer() as App;
      const nonAdmin = await fx.seedAdminUser('http_cust', { role: RoleName.CUSTOMER });
      const suspAdmin = await fx.seedAdminUser('http_susp', { status: UserStatus.ACTIVE });

      const adminAToken = signUserToken(
        enabledHarness.jwtService,
        enabledHarness.configService,
        fx.adminA,
        [RoleName.ADMINISTRATOR],
      );
      const adminBToken = signUserToken(
        enabledHarness.jwtService,
        enabledHarness.configService,
        fx.adminB,
        [RoleName.ADMINISTRATOR],
      );
      const customerToken = signUserToken(
        enabledHarness.jwtService,
        enabledHarness.configService,
        nonAdmin,
        [RoleName.CUSTOMER],
      );
      const staleSuspendedToken = signUserToken(
        enabledHarness.jwtService,
        enabledHarness.configService,
        suspAdmin,
        [RoleName.ADMINISTRATOR],
      );

      await fx.ledger.prisma.user.update({
        where: { id: suspAdmin.id },
        data: { status: UserStatus.SUSPENDED },
      });

      const c = await fx.seedQuarantinedCase({ amount: '66.00' });
      const receipt = await fx.seedEvidenceReceipt({
        obligationId: c.obligationId,
        attemptId: c.attemptId,
        refundId: c.refundId,
        merchantAccountId: c.merchantAccountId,
      });

      await request(server)
        .get('/admin/refund-reconciliation/approvals')
        .expect(HttpStatus.UNAUTHORIZED);

      await request(server)
        .post('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          obligationId: c.obligationId,
          requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
          evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
          externalSettlementReference: `gw-http-${randomUUID().slice(0, 8)}`,
          evidenceReceiptIds: [receipt.id],
          rationale: 'Customer attempt should be rejected',
        })
        .expect(HttpStatus.FORBIDDEN);

      await request(server)
        .get('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${staleSuspendedToken}`)
        .expect(HttpStatus.FORBIDDEN);

      await request(server)
        .post('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          obligationId: c.obligationId,
          requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
          evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
          externalSettlementReference: `gw-spoof-${randomUUID().slice(0, 8)}`,
          evidenceReceiptIds: [receipt.id],
          rationale: 'Spoofing actor identity in body must fail validation',
          requestedByActorId: fx.adminB.id,
        })
        .expect(HttpStatus.BAD_REQUEST);

      const extRef = `gw-http-ok-${randomUUID().slice(0, 8)}`;
      const createRes = await request(server)
        .post('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          obligationId: c.obligationId,
          attemptId: c.attemptId,
          requestedOutcome: RefundReconciliationOutcome.VERIFIED_COMPLETED,
          evidenceType: 'AUTHENTICATED_SETTLEMENT_PORTAL',
          externalSettlementReference: extRef,
          evidenceReceiptIds: [receipt.id],
          evidenceDigest: receipt.evidenceDigest,
          rawEvidence: { authorizationHeader: 'Bearer secret-do-not-leak', ticket: 'PORTAL-OK' },
          rationale: 'End-to-end HTTP dual-control verified completion',
        })
        .expect(HttpStatus.CREATED);

      const createdBody = createRes.body as RefundApprovalResponseEntity & {
        executionClaimToken?: unknown;
      };
      const approvalId = createdBody.id;
      expect(createdBody.requestedByActorId).toBe(fx.adminA.id);
      expect(createdBody.status).toBe(RefundReconciliationApprovalStatus.REQUESTED);
      expect(JSON.stringify(createdBody)).not.toContain('secret-do-not-leak');
      expect(createdBody.executionClaimToken).toBeUndefined();

      await request(server)
        .post(`/admin/refund-reconciliation/approvals/${approvalId}/approve`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ expectedAuthorizationRevision: 1 })
        .expect(HttpStatus.FORBIDDEN);

      const appRes = await request(server)
        .post(`/admin/refund-reconciliation/approvals/${approvalId}/approve`)
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({
          expectedAuthorizationRevision: 1,
          expectedEvidenceDigest: receipt.evidenceDigest,
        })
        .expect(HttpStatus.OK);
      const appBody = appRes.body as RefundApprovalResponseEntity;
      expect(appBody.status).toBe(RefundReconciliationApprovalStatus.APPROVED);
      expect(appBody.approvedByActorId).toBe(fx.adminB.id);

      const execRes = await request(server)
        .post(`/admin/refund-reconciliation/approvals/${approvalId}/execute`)
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({
          expectedAuthorizationRevision: 2,
          expectedEvidenceDigest: receipt.evidenceDigest,
        })
        .expect(HttpStatus.OK);
      const execBody = execRes.body as RefundReconciliationExecutionResponseEntity;
      expect(execBody.applied).toBe(true);
      expect(execBody.attemptStatus).toBe(RefundAttemptStatus.COMPLETED);
      expect(execBody.obligationStatus).toBe(RefundObligationStatus.FULFILLED);
      expect(execBody.approval.status).toBe(RefundReconciliationApprovalStatus.APPLIED);

      const inspectRes = await request(server)
        .get(`/admin/refund-reconciliation/obligations/${c.obligationId}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .expect(HttpStatus.OK);
      const inspectBody = inspectRes.body as RefundObligationInspectionResponseEntity;
      expect(inspectBody.status).toBe(RefundObligationStatus.FULFILLED);
      expect(inspectBody.reconciliationApprovals).toHaveLength(1);

      // Quarantined execution returns 409 Conflict over HTTP while committing QUARANTINED in DB
      const cQuar = await fx.seedQuarantinedCase({ amount: '44.00' });
      const qCreate = await request(server)
        .post('/admin/refund-reconciliation/approvals')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          obligationId: cQuar.obligationId,
          attemptId: cQuar.attemptId,
          requestedOutcome: RefundReconciliationOutcome.VERIFIED_FAILED,
          evidenceType: 'AUTHENTICATED_GATEWAY_DECLINE',
          rationale: 'HTTP 409 quarantine response check',
        })
        .expect(HttpStatus.CREATED);
      const qId = (qCreate.body as RefundApprovalResponseEntity).id;
      await request(server)
        .post(`/admin/refund-reconciliation/approvals/${qId}/approve`)
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({})
        .expect(HttpStatus.OK);
      const qExec = await request(server)
        .post(`/admin/refund-reconciliation/approvals/${qId}/execute`)
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({ expectedEvidenceDigest: 'f'.repeat(64) })
        .expect(HttpStatus.CONFLICT);
      expect((qExec.body as { code?: string }).code).toBe('RECONCILIATION_QUARANTINED');
    } finally {
      await enabledHarness.app.close();
      if (prevApiFlag !== undefined) {
        process.env.REFUND_RECONCILIATION_API_ENABLED = prevApiFlag;
      }
    }
  });
});
