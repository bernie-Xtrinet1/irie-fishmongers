import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CataloguePhotoApprovalStatus,
  RegulatoryStatus,
  RoleName,
  UserPermissionAuditAction,
  UserStatus,
} from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../../../app.module';
import { HttpExceptionFilter } from '../../../common/http/http-exception.filter';
import { PrismaService } from '../../../database/prisma.service';

jest.setTimeout(120_000);

interface LoginEnvelope {
  data: {
    accessToken: string;
    user: {
      id: string;
      email: string;
      roles: RoleName[];
      status: UserStatus;
      canAuthorizeVendorSettlements?: boolean;
      canManageCataloguePhotos?: boolean;
    };
  };
}

interface StaffAccessListEnvelope {
  data: {
    staff: Array<{
      id: string;
      email: string;
      status: UserStatus;
      roles: RoleName[];
      canManageCataloguePhotos: boolean;
    }>;
    auditLogs: Array<{
      id: string;
      targetUserId: string;
      targetEmail: string;
      actorUserId: string;
      actorEmail: string;
      permissionName: string;
      action: UserPermissionAuditAction;
      previousValue: boolean;
      newValue: boolean;
      createdAt: string;
    }>;
  };
}

interface UpdateStaffAccessEnvelope {
  data: {
    changed: boolean;
    staff: {
      id: string;
      canManageCataloguePhotos: boolean;
    };
    auditLog: {
      id: string;
      targetUserId: string;
      actorUserId: string;
      action: UserPermissionAuditAction;
      previousValue: boolean;
      newValue: boolean;
      createdAt: string;
    } | null;
  };
}

describe('Catalogue Photo Staff Access Delegation & Audit Immutability (PG Suite)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const password = 'StrongPassword1!';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    const configService = app.get(ConfigService);
    app.use(cookieParser());
    app.setGlobalPrefix(configService.getOrThrow<string>('API_PREFIX'));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function seedUser(opts: {
    roleName: RoleName;
    canAuthorizeVendorSettlements?: boolean;
    canManageCataloguePhotos?: boolean;
    status?: UserStatus;
    login?: boolean;
  }) {
    const email = `cat_perm_${opts.roleName.toLowerCase()}_${randomUUID().slice(0, 8)}@example.com`;
    const passwordHash = await bcrypt.hash(password, 4);
    const role = await prisma.role.upsert({
      where: { name: opts.roleName },
      update: {},
      create: { name: opts.roleName },
    });

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: opts.roleName,
        lastName: 'Tester',
        status: opts.status ?? UserStatus.ACTIVE,
        canAuthorizeVendorSettlements: opts.canAuthorizeVendorSettlements ?? false,
        canManageCataloguePhotos: opts.canManageCataloguePhotos ?? false,
        emailVerifiedAt: new Date(),
        roles: { create: [{ roleId: role.id }] },
      },
    });

    let accessToken = '';
    if (opts.login) {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      const body = loginRes.body as LoginEnvelope;
      accessToken = body.data.accessToken;
    }

    return { user, email, accessToken };
  }

  it('enforces Primary Administrator authorization, handles concurrent delegation atomically, enforces live revocation, and preserves immutable SQL audit logs', async () => {
    const server = app.getHttpServer();

    const primaryAdmin = await seedUser({
      roleName: RoleName.ADMINISTRATOR,
      canAuthorizeVendorSettlements: true,
      canManageCataloguePhotos: true,
      login: true,
    });
    const ordinaryAdmin = await seedUser({
      roleName: RoleName.ADMINISTRATOR,
      canAuthorizeVendorSettlements: false,
      canManageCataloguePhotos: true,
      login: true,
    });
    const opsStaff = await seedUser({
      roleName: RoleName.OPERATIONS_STAFF,
      canAuthorizeVendorSettlements: false,
      canManageCataloguePhotos: false,
      login: true,
    });
    const suspendedStaff = await seedUser({
      roleName: RoleName.OPERATIONS_STAFF,
      status: UserStatus.SUSPENDED,
      canManageCataloguePhotos: false,
    });
    const vendorTarget = await seedUser({
      roleName: RoleName.VENDOR,
      canManageCataloguePhotos: false,
    });
    const concurrentStaff = await seedUser({
      roleName: RoleName.OPERATIONS_STAFF,
      canManageCataloguePhotos: false,
    });

    const species = await prisma.species.create({
      data: {
        scientificName: `Lutjanus_perm_${randomUUID().slice(0, 6)}`,
        commercialName: 'Delegation Test Snapper',
        regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
      },
    });
    const photo = await prisma.cataloguePhoto.create({
      data: {
        speciesId: species.id,
        title: 'Bundled Snapper Verification',
        scientificName: species.scientificName,
        jamaicanAliases: ['Snapper'],
        imageUrl: '/catalogue-photos/lutjanus-analis.png',
        storageProvider: 'BUNDLED',
        sourceName: 'Test Fixture',
        sourceUrl: 'https://iriefishmongers.test',
        photographer: 'Test Photographer',
        licenseName: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        modifications: 'None',
        approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
      },
    });

    // 1. Anonymous & non-Primary-Admin actors denied on /staff-access
    await request(server).get('/api/v1/admin/catalogue-photos/staff-access').expect(401);
    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: true })
      .expect(401);

    await request(server)
      .get('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${ordinaryAdmin.accessToken}`)
      .expect(403);
    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${ordinaryAdmin.accessToken}`)
      .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: true })
      .expect(403);

    await request(server)
      .get('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);
    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: true })
      .expect(403);

    // 2. Staff starts blocked from Catalogue Photos routes
    await request(server)
      .get('/api/v1/admin/catalogue-photos')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);
    await request(server)
      .get(`/api/v1/admin/catalogue-photos/${photo.id}/image`)
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);

    // 3. Input validation & target restrictions (no extra fields, no self, no non-staff/inactive)
    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({
        targetUserId: opsStaff.user.id,
        canManageCataloguePhotos: true,
        canAuthorizeVendorSettlements: true,
      })
      .expect(400);

    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({ targetUserId: primaryAdmin.user.id, canManageCataloguePhotos: false })
      .expect(400);

    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({ targetUserId: ordinaryAdmin.user.id, canManageCataloguePhotos: false })
      .expect(400);

    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({ targetUserId: suspendedStaff.user.id, canManageCataloguePhotos: true })
      .expect(400);

    await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({ targetUserId: vendorTarget.user.id, canManageCataloguePhotos: true })
      .expect(400);

    const rejectedAuditCount = await prisma.userPermissionAuditLog.count({
      where: {
        targetUserId: {
          in: [
            primaryAdmin.user.id,
            ordinaryAdmin.user.id,
            suspendedStaff.user.id,
            vendorTarget.user.id,
          ],
        },
      },
    });
    expect(rejectedAuditCount).toBe(0);

    // 4. Concurrent duplicate grants serialize under FOR UPDATE and record exactly 1 audit entry
    const [grantResA, grantResB] = await Promise.all([
      request(server)
        .patch('/api/v1/admin/catalogue-photos/staff-access')
        .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
        .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: true })
        .expect(200),
      request(server)
        .patch('/api/v1/admin/catalogue-photos/staff-access')
        .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
        .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: true })
        .expect(200),
    ]);

    const bodyA = grantResA.body as UpdateStaffAccessEnvelope;
    const bodyB = grantResB.body as UpdateStaffAccessEnvelope;
    const changedFlags = [bodyA.data.changed, bodyB.data.changed].sort();
    expect(changedFlags).toEqual([false, true]);

    const logsAfterGrant = await prisma.userPermissionAuditLog.findMany({
      where: { targetUserId: opsStaff.user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logsAfterGrant).toHaveLength(1);
    expect(logsAfterGrant[0]).toMatchObject({
      targetUserId: opsStaff.user.id,
      targetEmail: opsStaff.email,
      actorUserId: primaryAdmin.user.id,
      actorEmail: primaryAdmin.email,
      permissionName: 'canManageCataloguePhotos',
      action: UserPermissionAuditAction.GRANT_CATALOGUE_PHOTO_ACCESS,
      previousValue: false,
      newValue: true,
    });

    // 5. Same active staff Bearer token now accesses Catalogue Photos & protected preview,
    // while admin-only publish remains forbidden (403)
    await request(server)
      .get('/api/v1/admin/catalogue-photos')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(200);

    const previewRes = await request(server)
      .get(`/api/v1/admin/catalogue-photos/${photo.id}/image`)
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(200);
    expect(previewRes.headers['content-type']).toContain('image/png');

    await request(server)
      .post(`/api/v1/admin/catalogue-photos/${photo.id}/approve`)
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .send({ isDefault: false })
      .expect(403);

    // 6. Primary Admin lists eligible staff & audit logs, then revokes access
    const listRes = await request(server)
      .get('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .expect(200);
    const listBody = listRes.body as StaffAccessListEnvelope;
    expect(listBody.data.staff.some((s) => s.id === opsStaff.user.id && s.canManageCataloguePhotos)).toBe(
      true,
    );
    expect(listBody.data.staff.some((s) => s.id === suspendedStaff.user.id)).toBe(false);
    expect(listBody.data.staff.some((s) => s.id === ordinaryAdmin.user.id)).toBe(false);
    expect(listBody.data.auditLogs.some((a) => a.id === logsAfterGrant[0]!.id)).toBe(true);

    const revokeRes = await request(server)
      .patch('/api/v1/admin/catalogue-photos/staff-access')
      .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
      .send({ targetUserId: opsStaff.user.id, canManageCataloguePhotos: false })
      .expect(200);
    const revokeBody = revokeRes.body as UpdateStaffAccessEnvelope;
    expect(revokeBody.data.changed).toBe(true);
    expect(revokeBody.data.auditLog).toMatchObject({
      action: UserPermissionAuditAction.REVOKE_CATALOGUE_PHOTO_ACCESS,
      previousValue: true,
      newValue: false,
      actorUserId: primaryAdmin.user.id,
      targetUserId: opsStaff.user.id,
    });

    // 7. Existing active staff Bearer session is IMMEDIATELY blocked (403) without re-login
    await request(server)
      .get('/api/v1/admin/catalogue-photos')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);
    await request(server)
      .get(`/api/v1/admin/catalogue-photos/${photo.id}/image`)
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);
    await request(server)
      .post('/api/v1/admin/catalogue-photos')
      .set('Authorization', `Bearer ${opsStaff.accessToken}`)
      .expect(403);

    // 8. Concurrent alternating grant + revoke serialize so DB matches final audit record
    await Promise.all([
      request(server)
        .patch('/api/v1/admin/catalogue-photos/staff-access')
        .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
        .send({ targetUserId: concurrentStaff.user.id, canManageCataloguePhotos: true })
        .expect(200),
      request(server)
        .patch('/api/v1/admin/catalogue-photos/staff-access')
        .set('Authorization', `Bearer ${primaryAdmin.accessToken}`)
        .send({ targetUserId: concurrentStaff.user.id, canManageCataloguePhotos: false })
        .expect(200),
    ]);
    const finalUser = await prisma.user.findUniqueOrThrow({
      where: { id: concurrentStaff.user.id },
      select: { canManageCataloguePhotos: true },
    });
    const concurrentLogs = await prisma.userPermissionAuditLog.findMany({
      where: { targetUserId: concurrentStaff.user.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (concurrentLogs.length === 0) {
      expect(finalUser.canManageCataloguePhotos).toBe(false);
    } else {
      expect(finalUser.canManageCataloguePhotos).toBe(
        concurrentLogs[concurrentLogs.length - 1]!.newValue,
      );
      expect(concurrentLogs[0]!.previousValue).toBe(false);
      for (let i = 1; i < concurrentLogs.length; i += 1) {
        expect(concurrentLogs[i]!.previousValue).toBe(concurrentLogs[i - 1]!.newValue);
      }
    }

    // 9. Database immutability triggers block UPDATE and DELETE on user_permission_audit_logs
    const auditId = logsAfterGrant[0]!.id;
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "user_permission_audit_logs" SET "newValue" = false WHERE "id" = '${auditId}'`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "user_permission_audit_logs" WHERE "id" = '${auditId}'`,
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
