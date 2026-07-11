import type { Server } from 'http';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';

// Mirrors the exact CORS setup in src/main.ts's bootstrap() - the e2e test
// harness builds the app via createNestApplication() rather than running
// main.ts, so enableCors() must be replicated here to exercise the same
// allowlist behavior the deployed app actually has.
describe('CORS (e2e)', () => {
  let app: INestApplication;
  const allowedOrigin = 'http://localhost:3002';
  const disallowedOrigin = 'http://evil.example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const configService = app.get(ConfigService);
    app.setGlobalPrefix(configService.getOrThrow<string>('API_PREFIX'));

    const corsOrigins = configService
      .getOrThrow<string>('CORS_ORIGIN')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    app.enableCors({ origin: corsOrigins, credentials: true });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  it('accepts a preflight request from an approved admin-dashboard origin with credentials', async () => {
    const res = await request(server())
      .options('/api/v1/health')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not echo back an unapproved origin', async () => {
    const res = await request(server())
      .options('/api/v1/health')
      .set('Origin', disallowedOrigin)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).not.toBe(disallowedOrigin);
  });
});
