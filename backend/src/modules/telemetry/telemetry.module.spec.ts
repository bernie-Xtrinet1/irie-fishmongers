import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { RoleName, UserStatus } from '@prisma/client';
import type { Server } from 'http';
import request from 'supertest';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { RedisModule } from '../../common/redis/redis.module';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaModule } from '../../database/prisma.module';
import { PrismaService } from '../../database/prisma.service';
import { TelemetryIngestionController } from './controllers/telemetry-ingestion.controller';
import { TelemetryOperationsController } from './controllers/telemetry-operations.controller';
import { TelemetryGatewayAuthGuard } from './guards/telemetry-gateway-auth.guard';
import { TelemetryModule } from './telemetry.module';

describe('TelemetryModule DI & Auth Guard Wiring', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let jwtService: JwtService;

  const prismaMock = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        if (where.id === 'ops-staff-1') {
          return Promise.resolve({
            id: 'ops-staff-1',
            email: 'staff.operations@iriefishmongers.test',
            status: UserStatus.ACTIVE,
            canAuthorizeVendorSettlements: false,
            roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
          });
        }
        return Promise.resolve(null);
      }),
    },
    deliveryRun: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    delivery: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    fleetAsset: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const redisClientMock = {
    status: 'ready',
    on: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    hset: jest.fn().mockResolvedValue(1),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(0),
    eval: jest.fn().mockResolvedValue(null),
    evalsha: jest.fn().mockResolvedValue(null),
    script: jest.fn().mockResolvedValue('sha1-stub'),
  };

  const redisServiceMock = {
    getClient: jest.fn(() => redisClientMock),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(0),
    onModuleDestroy: jest.fn(),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_ACCESS_SECRET: 'telemetry-module-regression-secret-32ch',
              JWT_ACCESS_EXPIRES_IN: '15m',
              JWT_REFRESH_SECRET: 'telemetry-module-regression-refresh-32c',
              JWT_REFRESH_EXPIRES_IN: '7d',
              CHECKOUT_QUOTE_SIGNING_SECRET: 'telemetry-module-quote-secret-32-chars',
              REDIS_URL: 'redis://127.0.0.1:6379',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        RedisModule,
        TelemetryModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(REDIS_CLIENT)
      .useValue(redisClientMock)
      .overrideProvider(RedisService)
      .useValue(redisServiceMock)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('compiles real TelemetryModule and resolves TelemetryOperationsController with real AuthModule guards', () => {
    expect(moduleRef.get(TelemetryOperationsController)).toBeInstanceOf(
      TelemetryOperationsController,
    );
    expect(moduleRef.get(TelemetryIngestionController)).toBeInstanceOf(
      TelemetryIngestionController,
    );
    expect(moduleRef.get(JwtAuthGuard)).toBeInstanceOf(JwtAuthGuard);
    expect(moduleRef.get(RolesGuard)).toBeInstanceOf(RolesGuard);
    expect(moduleRef.get(TelemetryGatewayAuthGuard)).toBeInstanceOf(
      TelemetryGatewayAuthGuard,
    );
    expect(jwtService).toBeInstanceOf(JwtService);
  });

  it('enforces real JwtAuthGuard, RolesGuard, and TelemetryGatewayAuthGuard on compiled routes', async () => {
    const httpServer = app.getHttpServer() as Server;

    await request(httpServer).get('/telemetry/overview/active-runs').expect(401);

    const staffToken = await jwtService.signAsync({
      sub: 'ops-staff-1',
      email: 'staff.operations@iriefishmongers.test',
      roles: [RoleName.OPERATIONS_STAFF],
    });

    const runsRes = await request(httpServer)
      .get('/telemetry/overview/active-runs')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    const overviewBody = runsRes.body as {
      generatedAt: unknown;
      vehicles: unknown[];
      runs: unknown[];
      activeDeliveries: unknown[];
    };
    expect(typeof overviewBody.generatedAt).toBe('string');
    expect(overviewBody.vehicles).toEqual([]);
    expect(overviewBody.runs).toEqual([]);
    expect(overviewBody.activeDeliveries).toEqual([]);

    await request(httpServer)
      .post('/telemetry/compartments')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        fleetAssetId: 'veh-1',
        compartmentCode: 'VAN1-CHILL',
        label: 'Chiller Box',
      })
      .expect(403);

    await request(httpServer)
      .post('/telemetry/codec8e')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ payloadHex: '00' })
      .expect(401);
  });
});
