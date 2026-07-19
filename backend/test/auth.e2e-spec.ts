import { randomUUID } from 'crypto';
import type { Server } from 'http';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request, { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { ApiResponse } from '../src/common/http/api-response';
import { HttpExceptionFilter } from '../src/common/http/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';

function data<T>(res: Response): T {
  return (res.body as ApiResponse<T>).data as T;
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdEmails: string[] = [];

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
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    if (app) {
      await app.close();
    }
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function uniqueEmail(): string {
    const email = `e2e-${randomUUID()}@example.com`;
    createdEmails.push(email);
    return email;
  }

  it('supports the full register -> login -> me -> refresh -> logout flow', async () => {
    const email = uniqueEmail();

    const registerRes = await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    interface UserData {
      email: string;
      status: string;
      roles: string[];
    }
    interface SessionData {
      accessToken: string;
      refreshToken: string;
    }

    expect(registerRes.status).toBe(201);
    expect((registerRes.body as ApiResponse<UserData>).success).toBe(true);
    const registeredUser = data<UserData>(registerRes);
    expect(registeredUser.email).toBe(email);
    expect(registeredUser.status).toBe('PENDING_VERIFICATION');
    expect(registeredUser.roles).toEqual(['CUSTOMER']);

    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'StrongPass1' });

    expect(loginRes.status).toBe(200);
    const { accessToken, refreshToken } = data<SessionData>(loginRes);
    expect(accessToken).toEqual(expect.any(String));
    expect(refreshToken).toEqual(expect.any(String));

    const meRes = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);
    expect(data<{ email: string }>(meRes).email).toBe(email);

    const refreshRes = await request(server())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    const newRefreshToken = data<SessionData>(refreshRes).refreshToken;
    expect(newRefreshToken).not.toBe(refreshToken);

    const reuseRes = await request(server())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(reuseRes.status).toBe(401);

    const logoutRes = await request(server())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: newRefreshToken });
    expect(logoutRes.status).toBe(200);

    const refreshAfterLogoutRes = await request(server())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: newRefreshToken });
    expect(refreshAfterLogoutRes.status).toBe(401);
  });

  it('rejects GET /auth/me without a token', async () => {
    const res = await request(server()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects registration when passwords do not match', async () => {
    const res = await request(server()).post('/api/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'StrongPass1',
      confirmPassword: 'Mismatch1',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(res.status).toBe(400);
  });

  it('rejects registration for a duplicate email', async () => {
    const email = uniqueEmail();
    const payload = {
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Jane',
      lastName: 'Doe',
    };

    await request(server()).post('/api/v1/auth/register').send(payload).expect(201);
    const res = await request(server()).post('/api/v1/auth/register').send(payload);
    expect(res.status).toBe(409);
  });

  it('rejects login with an incorrect password', async () => {
    const email = uniqueEmail();
    await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass1' });
    expect(res.status).toBe(401);
  });

  it('always reports success for forgot-password, even for an unknown email', async () => {
    const res = await request(server())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'unknown-user@example.com' });
    expect(res.status).toBe(200);
    expect(data<{ success: boolean }>(res)).toEqual({ success: true });
  });

  it('rejects reset-password with an invalid token', async () => {
    const res = await request(server()).post('/api/v1/auth/reset-password').send({
      token: 'not-a-real-token',
      newPassword: 'NewStrongPass1',
      confirmPassword: 'NewStrongPass1',
    });
    expect(res.status).toBe(400);
  });

  it('rejects verify-email with an invalid token', async () => {
    const res = await request(server())
      .post('/api/v1/auth/verify-email')
      .send({ token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });

});
