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

interface DriverData {
  id: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

interface ProductData {
  id: string;
}

interface PaymentData {
  id: string;
}

interface OrderData {
  id: string;
  payment?: PaymentData;
}

interface DashboardSummaryData {
  financials: { grossPaidAmount: string; platformCommission: string; currency: string };
  orders: { customerOrdersTotal: number; vendorOrdersByStatus: Record<string, number> };
  vendors: { byStatus: Record<string, number> };
  drivers: { byStatus: Record<string, number> };
  compliance: { activeAlertsBySeverity: Record<string, number>; activeRecalls: number };
  systemHealth: { postgres: string; redis: string };
}

interface VendorDashboardData {
  byStatus: Record<string, number>;
  byTier: Record<string, number>;
  averageComplianceScore: number | null;
  topVendorsByRevenue: { vendorId: string; businessName: string; grossAmount: string }[];
}

jest.setTimeout(20_000);

describe('Analytics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const customerEmails: string[] = [];
  const vendorUserEmails: string[] = [];
  const driverUserEmails: string[] = [];
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
    if (vendorUserEmails.length > 0) {
      await prisma.inventoryEvent.deleteMany({
        where: { product: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
      await prisma.user.deleteMany({ where: { email: { in: vendorUserEmails } } });
    }
    if (driverUserEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: driverUserEmails } } });
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

    const uploadRes = await request(server())
      .post('/api/v1/vendor-documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ documentType: 'GOVERNMENT_ID', fileUrl: 'https://cdn.example.com/vendor-docs/doc.jpg' });
    await request(server())
      .patch(`/api/v1/vendor-documents/${data<{ id: string }>(uploadRes).id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });

    return { accessToken, vendorId };
  }

  async function createApprovedDriverAndLogin(adminToken: string, licensePlate: string): Promise<string> {
    const email = `driver-${randomUUID()}@example.com`;
    driverUserEmails.push(email);
    await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Dana',
      lastName: 'Driver',
      role: 'DRIVER',
    });
    const loginRes = await request(server()).post('/api/v1/auth/login').send({ email, password: 'StrongPass1' });
    const accessToken = data<SessionData>(loginRes).accessToken;

    const registerRes = await request(server())
      .post('/api/v1/drivers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ licensePlate, vehicleType: 'CAR', vehicleOwnership: 'PERSONAL_VEHICLE' });
    const driverId = data<DriverData>(registerRes).id;

    await request(server())
      .patch(`/api/v1/drivers/${driverId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    return driverId;
  }

  async function getFishCategory(): Promise<CategoryData> {
    const res = await request(server()).get('/api/v1/categories');
    const categories = data<CategoryData[]>(res);
    return categories.find((category) => category.slug === 'fish')!;
  }

  it('rejects a non-admin request', async () => {
    const customerToken = await createCustomerAndLogin();

    const res = await request(server())
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(server()).get('/api/v1/analytics/dashboard-summary');
    expect(res.status).toBe(401);
  });

  it('returns a shape-correct summary reflecting a paid payment, an approved vendor, and an approved driver', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Analytics Vendor');
    await createApprovedDriverAndLogin(adminToken, 'AN 1111');
    const category = await getFishCategory();

    const productRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: `Analytics Test Snapper ${randomUUID()}`,
        description: 'A product created for Analytics e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    const product = data<ProductData>(productRes);

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 2 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        deliveryAddressLine1: '1 Ocean View Road',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551234',
        paymentMethod: 'CASH_ON_DELIVERY',
      });
    const order = data<OrderData>(checkoutRes);

    await request(server())
      .patch(`/api/v1/payments/${order.payment!.id}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(server())
      .get('/api/v1/analytics/dashboard-summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const summary = data<DashboardSummaryData>(res);
    expect(Number(summary.financials.grossPaidAmount)).toBeGreaterThanOrEqual(1000);
    expect(summary.financials.currency).toBe('JMD');
    expect(summary.orders.customerOrdersTotal).toBeGreaterThanOrEqual(1);
    expect(summary.vendors.byStatus.APPROVED).toBeGreaterThanOrEqual(1);
    expect(summary.drivers.byStatus.APPROVED).toBeGreaterThanOrEqual(1);
    expect(summary.systemHealth.postgres).toBe('up');
    expect(summary.systemHealth.redis).toBe('up');
  });

  it('narrows grossPaidAmount to the given date range', async () => {
    const adminToken = await createAdminAndLogin();

    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await request(server())
      .get('/api/v1/analytics/dashboard-summary')
      .query({ from: future })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const summary = data<DashboardSummaryData>(res);
    expect(summary.financials.grossPaidAmount).toBe('0');
  });

  it('rejects a range where from is later than to', async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(server())
      .get('/api/v1/analytics/dashboard-summary')
      .query({ from: '2026-12-31', to: '2026-01-01' })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  it('rejects a non-admin request to the vendor dashboard', async () => {
    const customerToken = await createCustomerAndLogin();

    const res = await request(server())
      .get('/api/v1/analytics/vendor-dashboard')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
  });

  it('returns a shape-correct vendor dashboard reflecting an approved COMMUNITY_FISHER vendor', async () => {
    const adminToken = await createAdminAndLogin();
    await createApprovedVendorAndLogin(adminToken, 'Vendor Dashboard Test Vendor');

    const res = await request(server())
      .get('/api/v1/analytics/vendor-dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const summary = data<VendorDashboardData>(res);
    expect(summary.byStatus.APPROVED).toBeGreaterThanOrEqual(1);
    expect(summary.byTier.COMMUNITY_FISHER).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(summary.topVendorsByRevenue)).toBe(true);
  });
});
