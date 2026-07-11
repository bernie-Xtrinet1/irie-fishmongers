import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { Server } from 'http';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RoleName } from '@prisma/client';
import request, { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { ApiResponse } from '../src/common/http/api-response';
import { HttpExceptionFilter } from '../src/common/http/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';

function data<T>(res: Response): T {
  return (res.body as ApiResponse<T>).data as T;
}

interface SessionData {
  accessToken: string;
}

interface VendorData {
  id: string;
}

interface LotData {
  id: string;
  lotNumber: string;
}

interface QrCodeData {
  passportUrl: string;
  dataUri: string;
}

interface PassportData {
  passportVersion: string;
  lot: { lotNumber: string; foodSafetyStatus: string };
  origin: unknown;
  custody: Array<{ eventType: string; fromRole: string | null; toRole: string | null }>;
  coldChainSummary: { totalReadings: number; unresolvedAlerts: number; worstSeverity: string | null };
  certifications: unknown[];
  sustainability: unknown;
}

describe('Digital Product Passport (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const vendorUserEmails: string[] = [];
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
    if (vendorUserEmails.length > 0) {
      await prisma.chainOfCustodyEvent.deleteMany({
        where: { lot: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
      await prisma.seafoodLot.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
      await prisma.user.deleteMany({ where: { email: { in: vendorUserEmails } } });
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
    return data<SessionData>(loginRes).accessToken;
  }

  async function createApprovedVendorAndLogin(
    adminToken: string,
    businessName: string,
  ): Promise<{ accessToken: string; vendorId: string }> {
    const email = `vendor-${randomUUID()}@example.com`;
    vendorUserEmails.push(email);
    await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Vera',
      lastName: 'Vendor',
      role: 'VENDOR',
    });
    const loginRes = await request(server()).post('/api/v1/auth/login').send({ email, password: 'StrongPass1' });
    const accessToken = data<SessionData>(loginRes).accessToken;

    const registerRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ businessName, parish: 'KINGSTON', acceptedTerms: true });
    const vendorId = data<VendorData>(registerRes).id;

    await request(server())
      .patch(`/api/v1/vendors/${vendorId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    return { accessToken, vendorId };
  }

  async function registerLot(vendorAccessToken: string): Promise<LotData> {
    const res = await request(server())
      .post('/api/v1/seafood-lots')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        species: 'Yellowfin Snapper',
        storageType: 'FRESH',
        catchDate: '2026-07-01',
        catchLocation: 'North Coast, Trelawny',
        landingSite: 'Falmouth Landing Site',
        weight: 40,
        weightUnit: 'POUNDS',
      });
    return data<LotData>(res);
  }

  it('generates a QR code for the owning vendor encoding the passport URL, and the passport resolves publicly', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Passport Vendor');
    const otherVendor = await createApprovedVendorAndLogin(adminToken, 'Other Passport Vendor');

    const lot = await registerLot(vendor.accessToken);

    const qrRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}/qr-code`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(qrRes.status).toBe(200);
    const qr = data<QrCodeData>(qrRes);
    expect(qr.passportUrl).toMatch(/^https:\/\/iriefishmongers\.com\/passport\/[0-9a-f-]{36}$/);
    expect(qr.dataUri.startsWith('data:image/png;base64,')).toBe(true);

    const forbiddenRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}/qr-code`)
      .set('Authorization', `Bearer ${otherVendor.accessToken}`);
    expect(forbiddenRes.status).toBe(403);

    const token = qr.passportUrl.split('/').pop()!;
    const passportRes = await request(server()).get(`/api/v1/passport/${token}`);
    expect(passportRes.status).toBe(200);
    const passport = data<PassportData>(passportRes);

    expect(passport.passportVersion).toBe('1.0.0');
    expect(passport.lot.lotNumber).toBe(lot.lotNumber);
    expect(passport.lot.foodSafetyStatus).toBe('SAFE');
    expect(passport.origin).toBeNull();
    expect(passport.sustainability).toBeNull();
    expect(passport.custody).toHaveLength(1);
    expect(passport.custody[0]).toMatchObject({ eventType: 'STORAGE_ENTRY', toRole: 'VENDOR' });
    expect(passport.coldChainSummary).toEqual({ totalReadings: 0, unresolvedAlerts: 0, worstSeverity: null });
    expect(passport.certifications).toEqual([]);
  });

  it('returns 404 for an unknown passport token', async () => {
    const res = await request(server()).get(`/api/v1/passport/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
