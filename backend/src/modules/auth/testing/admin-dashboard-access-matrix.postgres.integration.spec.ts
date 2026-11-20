import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Parish, RoleName, UserStatus } from '@prisma/client';
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
    user: { id: string; email: string; roles: RoleName[]; status: UserStatus };
  };
}

describe('Admin Dashboard Backend Access Matrix & Active Admin Enforcement (PG Suite)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const createdEmails: string[] = [];
  const createdSpeciesIds: string[] = [];
  const createdZoneIds: string[] = [];
  const createdSiteIds: string[] = [];
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
    if (prisma) {
      if (createdSpeciesIds.length > 0) {
        await prisma.species.deleteMany({ where: { id: { in: createdSpeciesIds } } });
      }
      if (createdZoneIds.length > 0) {
        await prisma.deliveryZone.deleteMany({ where: { id: { in: createdZoneIds } } });
      }
      if (createdSiteIds.length > 0) {
        await prisma.landingSite.deleteMany({ where: { id: { in: createdSiteIds } } });
      }
      if (createdEmails.length > 0) {
        await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
      }
    }
    if (app) {
      await app.close();
    }
  });

  async function seedUserAndLogin(roleName: RoleName, status: UserStatus = UserStatus.ACTIVE) {
    const email = `access_${roleName.toLowerCase()}_${randomUUID().slice(0, 8)}@example.com`;
    createdEmails.push(email);
    const passwordHash = await bcrypt.hash(password, 4);
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: roleName,
        lastName: 'Tester',
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        roles: { create: [{ roleId: role.id }] },
      },
    });

    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const body = loginRes.body as LoginEnvelope;

    if (status !== UserStatus.ACTIVE) {
      await prisma.user.update({ where: { id: user.id }, data: { status } });
    }

    return { user, email, accessToken: body.data.accessToken, agent };
  }

  const adminReadEndpoints = [
    '/api/v1/analytics/dashboard-summary',
    '/api/v1/analytics/vendor-dashboard',
    '/api/v1/analytics/sales-analytics',
    '/api/v1/analytics/delivery-analytics',
    '/api/v1/analytics/inventory-analytics',
    '/api/v1/vendors',
    '/api/v1/drivers',
    '/api/v1/admin/reviews',
    '/api/v1/admin/catalogue',
    '/api/v1/recalls',
    '/api/v1/food-safety-incidents',
  ];

  it('rejects anonymous (401) and CUSTOMER/VENDOR/DRIVER (403) across admin reads and writes while allowing active ADMINISTRATOR', async () => {
    const server = app.getHttpServer();
    const customer = await seedUserAndLogin(RoleName.CUSTOMER);
    const vendor = await seedUserAndLogin(RoleName.VENDOR);
    const driver = await seedUserAndLogin(RoleName.DRIVER);
    const admin = await seedUserAndLogin(RoleName.ADMINISTRATOR);

    for (const path of adminReadEndpoints) {
      await request(server).get(path).expect(401);
      await request(server).get(path).set('Authorization', `Bearer ${customer.accessToken}`).expect(403);
      await request(server).get(path).set('Authorization', `Bearer ${vendor.accessToken}`).expect(403);
      await request(server).get(path).set('Authorization', `Bearer ${driver.accessToken}`).expect(403);
      await request(server).get(path).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
    }

    const writeChecks: Array<{ path: string; payload: Record<string, unknown>; ids: string[] }> = [
      {
        path: '/api/v1/species',
        payload: {
          scientificName: `Lutjanus_${randomUUID().slice(0, 6)}`,
          commercialName: 'Snapper Test',
        },
        ids: createdSpeciesIds,
      },
      {
        path: '/api/v1/delivery-zones',
        payload: {
          name: `Zone ${randomUUID().slice(0, 6)}`,
          code: `Z_${randomUUID().slice(0, 6).toUpperCase()}`,
        },
        ids: createdZoneIds,
      },
      {
        path: '/api/v1/landing-sites',
        payload: {
          name: `Landing ${randomUUID().slice(0, 6)}`,
          parish: Parish.KINGSTON,
        },
        ids: createdSiteIds,
      },
    ];

    for (const check of writeChecks) {
      await request(server).post(check.path).send(check.payload).expect(401);
      for (const nonAdminToken of [customer.accessToken, vendor.accessToken, driver.accessToken]) {
        await request(server)
          .post(check.path)
          .set('Authorization', `Bearer ${nonAdminToken}`)
          .send(check.payload)
          .expect(403);
      }
      const created = await request(server)
        .post(check.path)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(check.payload)
        .expect(201);
      const id = (created.body as { data?: { id?: string } }).data?.id;
      if (id) check.ids.push(id);
    }
  });

  it('immediately invalidates stale admin JWTs when ADMINISTRATOR role is removed or account becomes non-ACTIVE', async () => {
    const server = app.getHttpServer();
    const demoted = await seedUserAndLogin(RoleName.ADMINISTRATOR);
    const customerRole = await prisma.role.upsert({
      where: { name: RoleName.CUSTOMER },
      update: {},
      create: { name: RoleName.CUSTOMER },
    });

    await request(server)
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${demoted.accessToken}`)
      .expect(200);

    await prisma.userRole.deleteMany({ where: { userId: demoted.user.id } });
    await prisma.userRole.create({ data: { userId: demoted.user.id, roleId: customerRole.id } });

    await request(server)
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${demoted.accessToken}`)
      .expect(403);

    const meRes = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${demoted.accessToken}`)
      .expect(200);
    expect((meRes.body as { data: { roles: RoleName[] } }).data.roles).toEqual([RoleName.CUSTOMER]);

    const refreshRes = await demoted.agent.post('/api/v1/auth/refresh').send({}).expect(200);
    expect((refreshRes.body as LoginEnvelope).data.user.roles).toEqual([RoleName.CUSTOMER]);

    const pendingAdmin = await seedUserAndLogin(RoleName.ADMINISTRATOR, UserStatus.PENDING_VERIFICATION);
    await request(server)
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${pendingAdmin.accessToken}`)
      .expect(403);

    const suspendedAdmin = await seedUserAndLogin(RoleName.ADMINISTRATOR, UserStatus.SUSPENDED);
    await request(server)
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${suspendedAdmin.accessToken}`)
      .expect(403);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${suspendedAdmin.accessToken}`)
      .expect(403);

    await suspendedAdmin.agent.post('/api/v1/auth/refresh').send({}).expect(403);
    await suspendedAdmin.agent.post('/api/v1/auth/refresh').send({}).expect(401);
  });

  it('preserves public storefront, customer orders, shared authenticated pickers, and 501 reconciliation gate', async () => {
    const server = app.getHttpServer();
    const customer = await seedUserAndLogin(RoleName.CUSTOMER);
    const vendor = await seedUserAndLogin(RoleName.VENDOR);
    const admin = await seedUserAndLogin(RoleName.ADMINISTRATOR);

    await request(server).get('/api/v1/catalogue').expect(200);
    await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(200);

    for (const token of [customer.accessToken, vendor.accessToken]) {
      await request(server).get('/api/v1/delivery-zones').set('Authorization', `Bearer ${token}`).expect(200);
      await request(server).get('/api/v1/species').set('Authorization', `Bearer ${token}`).expect(200);
      await request(server).get('/api/v1/landing-sites').set('Authorization', `Bearer ${token}`).expect(200);
    }

    await request(server)
      .get('/api/v1/admin/refund-reconciliation/approvals')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(501);

    await request(server)
      .get('/api/v1/admin/refund-reconciliation/approvals')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(501);
  });
});
