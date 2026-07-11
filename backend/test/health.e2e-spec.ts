import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { Server } from 'http';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RoleName } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';

interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

interface SessionData {
  accessToken: string;
}

describe('Health (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const customerEmails: string[] = [];
  const adminEmails: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(app.get(ConfigService).getOrThrow<string>('API_PREFIX'));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (customerEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: customerEmails } } });
    }
    if (adminEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: adminEmails } } });
    }
    await app.close();
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  async function createAdminAndLogin(): Promise<string> {
    const email = `admin-${randomUUID()}@example.com`;
    adminEmails.push(email);
    const passwordHash = await bcrypt.hash('AdminPass1', 4);
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } });

    await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: 'Ada',
        lastName: 'Min',
        status: 'ACTIVE',
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });

    const loginRes = await request(server()).post('/api/v1/auth/login').send({ email, password: 'AdminPass1' });
    return (loginRes.body as ApiEnvelope<SessionData>).data!.accessToken;
  }

  async function createCustomerAndLogin(): Promise<string> {
    const email = `customer-${randomUUID()}@example.com`;
    customerEmails.push(email);
    await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Cara',
      lastName: 'Customer',
    });
    const loginRes = await request(server()).post('/api/v1/auth/login').send({ email, password: 'StrongPass1' });
    return (loginRes.body as ApiEnvelope<SessionData>).data!.accessToken;
  }

  describe('GET /health', () => {
    it('is public and reports connectivity without authentication', async () => {
      const res = await request(server()).get('/api/v1/health');
      // 200 when dependencies are up, 503 if this test run's Postgres/Redis
      // is unavailable - either way, no auth is required to reach it.
      expect([200, 503]).toContain(res.status);
    });
  });

  describe('GET /health/status', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(server()).get('/api/v1/health/status');
      expect(res.status).toBe(401);
    });

    it('rejects a non-admin request', async () => {
      const customerToken = await createCustomerAndLogin();

      const res = await request(server())
        .get('/api/v1/health/status')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
    });

    it('always resolves 200 with granular status for an admin', async () => {
      const adminToken = await createAdminAndLogin();

      const res = await request(server())
        .get('/api/v1/health/status')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const status = (res.body as ApiEnvelope<{ postgres: string; redis: string }>).data!;
      expect(status.postgres).toBe('up');
      expect(status.redis).toBe('up');
    });
  });
});
