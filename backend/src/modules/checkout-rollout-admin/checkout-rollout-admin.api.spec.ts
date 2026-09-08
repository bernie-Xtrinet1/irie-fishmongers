import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../database/prisma.service';
import { CheckoutDispatchModule } from '../checkout-dispatch/checkout-dispatch.module';
import { OrdersController } from '../orders/controllers/orders.controller';
import { OrdersService } from '../orders/services/orders.service';
import { CheckoutRolloutParticipantsRepository } from '../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { CheckoutRolloutAdminModule } from './checkout-rollout-admin.module';
import { RolloutControlsRepository } from './repositories/rollout-controls.repository';
import { RolloutControlsService } from './services/rollout-controls.service';
import { InactiveRolloutPolicyService } from './services/inactive-rollout-policy.service';
import { RolloutControlTelemetryService } from './services/rollout-control-telemetry.service';

describe('G.3a admin HTTP authorization and inactive module', () => {
  let app: INestApplication<Server>;
  let admin: string;
  let customer: string;
  const actorId = randomUUID();
  const customerId = randomUUID();
  const repository = { findCurrent: jest.fn(), appendIfCurrent: jest.fn(), listHistory: jest.fn() };
  const participants = {
    findCurrent: jest.fn(),
    appendIfCurrent: jest.fn(),
    listHistory: jest.fn(),
  };
  const record = jest.fn();
  const payload = {
    expectedRevision: null,
    newAdmissionStopped: true,
    behavior: 'DENY',
    eligibleCohort: null,
    reason: 'Safe initial policy',
  };
  const control = {
    id: randomUUID(),
    revision: 1,
    actorId,
    newAdmissionStopped: true,
    behavior: 'DENY',
    eligibleCohort: null,
    reason: payload.reason,
    createdAt: new Date(),
  };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        CheckoutRolloutAdminModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ $disconnect: jest.fn() })
      .overrideProvider(RolloutControlsRepository)
      .useValue(repository)
      .overrideProvider(CheckoutRolloutParticipantsRepository)
      .useValue(participants)
      .overrideProvider(RolloutControlTelemetryService)
      .useValue({ record })
      .compile();
    app = ref.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    const jwt = app.get(JwtService);
    admin = jwt.sign({ sub: actorId, email: 'admin@example.invalid', roles: ['ADMINISTRATOR'] });
    customer = jwt.sign({
      sub: customerId,
      email: 'customer@example.invalid',
      roles: ['CUSTOMER'],
    });
    expect(app.get(InactiveRolloutPolicyService)).toBeInstanceOf(InactiveRolloutPolicyService);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    repository.findCurrent.mockResolvedValue(control);
    repository.appendIfCurrent.mockResolvedValue({ ok: true, control });
    repository.listHistory.mockResolvedValue([control]);
    participants.findCurrent.mockResolvedValue(null);
    participants.listHistory.mockResolvedValue([]);
    participants.appendIfCurrent.mockResolvedValue({
      ok: true,
      participant: {
        id: randomUUID(),
        revision: 1,
        customerId,
        actorId,
        enabled: false,
        cohort: null,
        reason: 'Disable pilot',
        createdAt: new Date(),
      },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  const routes = [
    ['get', '/status'],
    ['get', '/control-revisions'],
    ['post', '/control-revisions'],
    ['get', `/participants/${customerId}`],
    ['get', `/participants/${customerId}/revisions`],
    ['post', `/participants/${customerId}/revisions`],
  ] as const;
  it.each(routes)('protects %s %s with real auth and role guards', async (method, path) => {
    await request(app.getHttpServer())[method](`/checkout-rollout${path}`).expect(401);
    await request(app.getHttpServer())
      [method](`/checkout-rollout${path}`)
      .set('Authorization', `Bearer ${customer}`)
      .expect(403);
    expect(repository.appendIfCurrent).not.toHaveBeenCalled();
    expect(participants.appendIfCurrent).not.toHaveBeenCalled();
  });
  it('allows admin status, explicitly separates configuration and activation', async () => {
    const response = await request(app.getHttpServer())
      .get('/checkout-rollout/status')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'CONFIGURED',
      newAdmissionStopped: true,
      productionDispatcherActive: false,
      legacyEndpointAffected: false,
    });
  });
  it.each(['absent', 'failure'])('does not fabricate stop state for %s', async (state) => {
    if (state === 'absent') repository.findCurrent.mockResolvedValue(null);
    else repository.findCurrent.mockRejectedValue(new Error('database details'));
    const response = await request(app.getHttpServer())
      .get('/checkout-rollout/status')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(response.body).toEqual({
      status: state === 'absent' ? 'ABSENT' : 'UNAVAILABLE',
      control: null,
      newAdmissionStopped: null,
      productionDispatcherActive: false,
      legacyEndpointAffected: false,
    });
  });
  it('takes global actor from verified token and trims reason', async () => {
    await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...payload, reason: '  Safe initial policy  ' })
      .expect(201);
    expect(repository.appendIfCurrent).toHaveBeenCalledWith(
      actorId,
      expect.objectContaining(payload),
    );
  });
  it.each([
    { actorId: randomUUID() },
    { operationKey: randomUUID() },
    { selectedPath: 'CART_SCOPED' },
    { attemptId: randomUUID() },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: '1' },
    { expectedRevision: 2147483647 },
    { behavior: 'MIRROR' },
    { eligibleCohort: '*' },
    { reason: '  ' },
    { reason: 'x'.repeat(501) },
    { newAdmissionStopped: 'false' },
  ])('rejects invalid/unknown global mutation fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...payload, ...invalid })
      .expect(400);
    expect(repository.appendIfCurrent).not.toHaveBeenCalled();
  });
  it('requires explicit nullable fields and expected revision', async () => {
    const { expectedRevision: _revision, ...missing } = payload;
    await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send(missing)
      .expect(400);
  });
  it('returns conflict without retrying the write', async () => {
    repository.appendIfCurrent.mockResolvedValue({ ok: false, code: 'STALE_REVISION' });
    await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send(payload)
      .expect(409);
    expect(repository.appendIfCurrent).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('global', 'conflict');
  });
  it('returns bounded errors for actor missing and database write failure', async () => {
    repository.appendIfCurrent.mockResolvedValue({ ok: false, code: 'ACTOR_NOT_FOUND' });
    await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send(payload)
      .expect(404);
    repository.appendIfCurrent.mockRejectedValue(new Error('private database details'));
    const response = await request(app.getHttpServer())
      .post('/checkout-rollout/control-revisions')
      .set('Authorization', `Bearer ${admin}`)
      .send(payload)
      .expect(500);
    expect(JSON.stringify(response.body)).not.toContain('private database');
  });
  it('bounds both histories, transforms cursors and rejects oversized/unknown queries', async () => {
    for (const path of ['/control-revisions', `/participants/${customerId}/revisions`]) {
      await request(app.getHttpServer())
        .get(`/checkout-rollout${path}?afterRevision=1&limit=2`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);
      for (const query of ['limit=201', 'limit=0', 'afterRevision=-1', 'unknown=true'])
        await request(app.getHttpServer())
          .get(`/checkout-rollout${path}?${query}`)
          .set('Authorization', `Bearer ${admin}`)
          .expect(400);
    }
    expect(repository.listHistory).toHaveBeenCalledWith(1, 2);
    expect(participants.listHistory).toHaveBeenCalledWith(customerId, 1, 2);
  });
  it('wraps G.1 mutation with authenticated actor and preserves conflict', async () => {
    const body = { expectedRevision: null, enabled: false, cohort: null, reason: 'Disable pilot' };
    const path = `/checkout-rollout/participants/${customerId}/revisions`;
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${admin}`)
      .send(body)
      .expect(201);
    expect(participants.appendIfCurrent).toHaveBeenCalledWith(customerId, actorId, body);
    participants.appendIfCurrent.mockResolvedValue({
      ok: false,
      code: 'STALE_REVISION',
      currentRevision: 1,
    });
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${admin}`)
      .send(body)
      .expect(409);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...body, actorId })
      .expect(400);
  });
  it('distinguishes absent participant and failed lookup, validates customer UUID', async () => {
    const path = `/checkout-rollout/participants/${customerId}`;
    const absent = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(absent.body).toEqual({ status: 'ABSENT', participant: null });
    participants.findCurrent.mockRejectedValue(new Error('private failure'));
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${admin}`)
      .expect(500);
    await request(app.getHttpServer())
      .get('/checkout-rollout/participants/invalid')
      .set('Authorization', `Bearer ${admin}`)
      .expect(400);
  });
  it('validates direct service calls as well as HTTP DTOs', async () => {
    const service = app.get(RolloutControlsService);
    await expect(
      service.append(actorId, { ...payload, behavior: 'INVALID' } as never),
    ).rejects.toThrow('Invalid rollout');
    expect(() => service.history({ afterRevision: 0, limit: 201 })).toThrow('Invalid history');
    await expect(
      service.setParticipant(customerId, actorId, { enabled: true } as never),
    ).rejects.toThrow('Invalid participation');
  });
  it('keeps production dispatcher absent and the real OrdersController delegated to legacy', async () => {
    const seen = new Set<unknown>();
    function visit(entry: unknown): void {
      if (!entry || seen.has(entry)) return;
      seen.add(entry);
      if (typeof entry === 'object') {
        const dynamic = entry as {
          module?: unknown;
          imports?: unknown[];
          forwardRef?: () => unknown;
        };
        if (dynamic.forwardRef) visit(dynamic.forwardRef());
        if (dynamic.module) visit(dynamic.module);
        dynamic.imports?.forEach(visit);
      } else if (typeof entry === 'function') {
        ((Reflect.getMetadata('imports', entry) as unknown[] | undefined) ?? []).forEach(visit);
      }
    }
    visit(AppModule);
    expect(seen.has(CheckoutRolloutAdminModule)).toBe(true);
    expect(seen.has(CheckoutDispatchModule)).toBe(false);
    const checkout = jest.fn().mockResolvedValue({ id: 'legacy-order' });
    const controller = new OrdersController({ checkout } as unknown as OrdersService);
    const dto = { paymentMethod: 'CASH_ON_DELIVERY' } as const;
    await controller.checkout({ id: customerId, email: '', roles: ['CUSTOMER'] }, dto as never);
    expect(checkout).toHaveBeenCalledWith(customerId, dto);
  });
});
