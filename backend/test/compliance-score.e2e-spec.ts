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

interface ExplanationData {
  vendorId: string;
  score: number | null;
  band: string;
  updatedAt: string | null;
  breakdown: {
    score: number;
    temperatureDeduction: number;
    inspectionDeduction: number;
    recallDeduction: number;
    certificationDeduction: number;
  };
}

jest.setTimeout(60_000);

// Seeds food-safety signals directly via Prisma (the signal-gathering and
// dedup logic is what's under test, not the food-safety write endpoints) and
// drives the admin compliance-score endpoints.
describe('Compliance score (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let adminUserId: string;
  let vendorId: string;
  const userIds: string[] = [];
  const lotIds: string[] = [];
  let recallId: string;
  let authorityId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(app.get(ConfigService).getOrThrow<string>('API_PREFIX'));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const server = app.getHttpServer() as Server;

    // Admin (via the real login) + a vendor and its signals (via Prisma).
    const adminEmail = `admin-${randomUUID()}@example.com`;
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.ADMINISTRATOR } });
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash('AdminPass1', 4),
        firstName: 'Ada',
        lastName: 'Min',
        status: 'ACTIVE',
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });
    adminUserId = admin.id;
    userIds.push(admin.id);
    adminToken = data<{ accessToken: string }>(
      await request(server).post('/api/v1/auth/login').send({ email: adminEmail, password: 'AdminPass1' }),
    ).accessToken;

    const vendorUser = await prisma.user.create({
      data: {
        email: `vendor-${randomUUID()}@example.com`,
        passwordHash: await bcrypt.hash('VendorPass1', 4),
        firstName: 'Vera',
        lastName: 'Vendor',
        status: 'ACTIVE',
      },
    });
    userIds.push(vendorUser.id);
    const vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        businessName: 'Signal Vendor',
        parish: 'KINGSTON',
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
        termsAcceptedAt: new Date(),
      },
    });
    vendorId = vendor.id;

    // Three lots for the same vendor - a single recall will touch all three
    // to prove it deducts once, not three times.
    for (let i = 0; i < 3; i += 1) {
      const lot = await prisma.seafoodLot.create({
        data: {
          lotNumber: `LOT-${randomUUID()}`,
          vendorId,
          species: 'Snapper',
          storageType: 'FRESH',
          catchDate: new Date(),
          weight: 10,
          weightUnit: 'POUNDS',
        },
      });
      lotIds.push(lot.id);
    }

    // One unresolved CRITICAL temperature alert on the first lot (-5).
    const reading = await prisma.temperatureReading.create({
      data: {
        lotId: lotIds[0]!,
        checkpoint: 'VENDOR_STORAGE',
        temperatureC: 12,
        recordedById: adminUserId,
      },
    });
    await prisma.temperatureAlert.create({
      data: { readingId: reading.id, lotId: lotIds[0]!, severity: 'CRITICAL', actualC: 12, resolved: false },
    });

    // One REJECTED inspection (-8).
    await prisma.qualityInspection.create({
      data: {
        lotId: lotIds[0]!,
        inspectorId: adminUserId,
        result: 'REJECTED',
        freshnessGrade: 'REJECTED',
        qualityScore: 40,
      },
    });

    // One ACTIVE recall spanning all three lots (-20, deduped to one recall).
    const recall = await prisma.recall.create({
      data: {
        severityClass: 'CLASS_I',
        status: 'ACTIVE',
        reason: 'Contamination suspected',
        createdById: adminUserId,
        lots: { create: lotIds.map((lotId) => ({ lotId })) },
      },
    });
    recallId = recall.id;

    // One EXPIRED vendor certification (-10). COMMUNITY_FISHER does not
    // require certs, so no flat missing-cert hit applies.
    const authority = await prisma.regulatoryAuthority.create({
      data: { name: `Authority ${randomUUID()}` },
    });
    authorityId = authority.id;
    await prisma.regulatoryCertification.create({
      data: {
        vendorId,
        certificateType: 'Food Safety',
        certificateNumber: `CERT-${randomUUID()}`,
        issuingAuthorityId: authority.id,
        issuedDate: new Date('2020-01-01'),
        expiryDate: new Date('2021-01-01'),
        status: 'EXPIRED',
      },
    });
  });

  afterAll(async () => {
    await prisma.regulatoryCertification.deleteMany({ where: { vendorId } });
    if (authorityId) {
      await prisma.regulatoryAuthority.deleteMany({ where: { id: authorityId } });
    }
    if (recallId) {
      await prisma.recallLot.deleteMany({ where: { recallId } });
      await prisma.recall.deleteMany({ where: { id: recallId } });
    }
    await prisma.qualityInspection.deleteMany({ where: { lotId: { in: lotIds } } });
    await prisma.temperatureAlert.deleteMany({ where: { lotId: { in: lotIds } } });
    await prisma.temperatureReading.deleteMany({ where: { lotId: { in: lotIds } } });
    await prisma.seafoodLot.deleteMany({ where: { id: { in: lotIds } } });
    await prisma.vendor.deleteMany({ where: { id: vendorId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (app) {
      await app.close();
    }
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  it('blocks non-admins from the compliance-score endpoints', async () => {
    await request(server()).get(`/api/v1/admin/vendors/${vendorId}/compliance-score`).expect(401);
  });

  it('recomputes and explains the score, deducting each signal once (recall deduped across 3 lots)', async () => {
    const recomputed = data<ExplanationData>(
      await request(server())
        .post(`/api/v1/admin/vendors/${vendorId}/compliance-score/recompute`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201),
    );

    // 100 - 5 (critical) - 8 (rejected) - 20 (one recall) - 10 (expired cert) = 57
    expect(recomputed.breakdown.temperatureDeduction).toBe(5);
    expect(recomputed.breakdown.inspectionDeduction).toBe(8);
    expect(recomputed.breakdown.recallDeduction).toBe(20); // NOT 60 - deduped
    expect(recomputed.breakdown.certificationDeduction).toBe(10);
    expect(recomputed.score).toBe(57);
    expect(recomputed.band).toBe('NEEDS_IMPROVEMENT');
    expect(recomputed.updatedAt).not.toBeNull();

    // Persisted write-through: the stored score matches and the dashboard
    // aggregate is no longer null.
    const stored = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(stored.complianceScore).toBe(57);
    expect(stored.complianceScoreUpdatedAt).not.toBeNull();
    const aggregate = await prisma.vendor.aggregate({ _avg: { complianceScore: true } });
    expect(aggregate._avg.complianceScore).not.toBeNull();

    // The explain endpoint returns the same breakdown on demand.
    const explained = data<ExplanationData>(
      await request(server())
        .get(`/api/v1/admin/vendors/${vendorId}/compliance-score`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200),
    );
    expect(explained.breakdown.score).toBe(57);
  });

  it('recovers the score once the recall is resolved (signal removed)', async () => {
    await prisma.recall.update({ where: { id: recallId }, data: { status: 'RESOLVED' } });

    const explained = data<ExplanationData>(
      await request(server())
        .post(`/api/v1/admin/vendors/${vendorId}/compliance-score/recompute`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201),
    );

    // Recall no longer ACTIVE/INVESTIGATING -> its 20-point deduction lifts.
    expect(explained.breakdown.recallDeduction).toBe(0);
    expect(explained.score).toBe(77); // 57 + 20
  });
});
