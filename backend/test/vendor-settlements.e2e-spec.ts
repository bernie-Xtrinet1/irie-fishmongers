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

interface ProductData {
  id: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

interface OrderData {
  id: string;
  payment?: { id: string };
  vendorOrders: { id: string; status: string }[];
}

interface DeliveryData {
  id: string;
}

interface SettlementData {
  id: string;
  vendorId: string;
  vendorOrderId: string;
  status: string;
  netAmount: string;
  adjustedNetAmount: string;
}

interface GenerateResultData {
  settlementsCreated: number;
}

// Each test registers several roles and drives an order through the full
// checkout -> delivery -> payment -> settlement lifecycle, well beyond
// Jest's default 5s per-test timeout.
jest.setTimeout(60_000);

describe('Vendor Settlements (e2e)', () => {
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
    if (vendorUserEmails.length > 0) {
      await prisma.vendorSettlement.deleteMany({
        where: { vendor: { user: { email: { in: vendorUserEmails } } } },
      });
    }
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
    if (app) {
      await app.close();
    }
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  async function createAdminAndLogin(): Promise<string> {
    const email = `admin-${randomUUID()}@example.com`;
    adminEmails.push(email);
    const passwordHash = await bcrypt.hash('AdminPass1', 4);
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMINISTRATOR },
    });

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

    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'AdminPass1' });
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
    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'StrongPass1' });
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
    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'StrongPass1' });
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

    // COMMUNITY_FISHER (the default tier on registration) requires an
    // APPROVED GOVERNMENT_ID before the vendor may list products.
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

  async function createApprovedDriverAndLogin(
    adminToken: string,
    licensePlate: string,
  ): Promise<{ accessToken: string; driverId: string }> {
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
    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'StrongPass1' });
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

    await request(server())
      .patch('/api/v1/drivers/me/availability')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'ONLINE' })
      .expect(200);

    return { accessToken, driverId };
  }

  async function getFishCategory(): Promise<CategoryData> {
    const res = await request(server()).get('/api/v1/categories');
    const categories = data<CategoryData[]>(res);
    return categories.find((category) => category.slug === 'fish')!;
  }

  async function createProduct(
    vendorAccessToken: string,
    categoryId: string,
    name: string,
  ): Promise<ProductData> {
    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        categoryId,
        name,
        description: 'A product created for Vendor Settlements e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  const deliveryInfo = {
    deliveryAddressLine1: '1 Ocean View Road',
    deliveryParish: 'KINGSTON' as const,
    deliveryPhone: '+18765551234',
    paymentMethod: 'CASH_ON_DELIVERY' as const,
  };

  async function completeAndPayOrder(
    adminToken: string,
    customerToken: string,
    vendorAccessToken: string,
    driverAccessToken: string,
    categoryId: string,
    productName: string,
  ): Promise<string> {
    const product = await createProduct(vendorAccessToken, categoryId, productName);

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);
    const order = data<OrderData>(checkoutRes);
    const vendorOrderId = order.vendorOrders[0]!.id;

    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .expect(200);
    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/preparing`)
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .expect(200);
    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/ready`)
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .expect(200);

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driverAccessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driverAccessToken}`)
      .send({ action: 'PICKED_UP' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driverAccessToken}`)
      .send({
        action: 'DELIVERED',
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof/photo.jpg',
      })
      .expect(200);

    const orderRes = await request(server())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${customerToken}`);
    const paymentId = data<OrderData>(orderRes).payment!.id;
    await request(server())
      .patch(`/api/v1/payments/${paymentId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    return vendorOrderId;
  }

  it('generates a settlement after a delivered and paid order, then approves and pays it', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Settlement Flow Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'VS 1111');
    const category = await getFishCategory();

    const vendorOrderId = await completeAndPayOrder(
      adminToken,
      customerToken,
      vendor.accessToken,
      driver.accessToken,
      category.id,
      'Settlement Flow Snapper',
    );

    const generateRes = await request(server())
      .post('/api/v1/vendor-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(generateRes.status).toBe(201);
    expect(data<GenerateResultData>(generateRes).settlementsCreated).toBeGreaterThanOrEqual(1);

    const mineRes = await request(server())
      .get('/api/v1/vendor-settlements/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(mineRes.status).toBe(200);
    const mine = data<{ items: SettlementData[] }>(mineRes);
    const settlement = mine.items.find((item) => item.vendorOrderId === vendorOrderId);
    expect(settlement).toBeDefined();
    expect(settlement!.status).toBe('PENDING');
    expect(Number(settlement!.netAmount)).toBeGreaterThan(0);
    expect(settlement!.adjustedNetAmount).toBe(settlement!.netAmount);

    const adminListRes = await request(server())
      .get('/api/v1/vendor-settlements')
      .query({ vendorId: vendor.vendorId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminListRes.status).toBe(200);
    const adminList = data<{ items: SettlementData[] }>(adminListRes);
    expect(adminList.items.some((item) => item.id === settlement!.id)).toBe(true);

    const replayRes = await request(server())
      .post('/api/v1/vendor-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<GenerateResultData>(replayRes).settlementsCreated).toBe(0);

    const approveRes = await request(server())
      .patch(`/api/v1/vendor-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });
    expect(approveRes.status).toBe(200);
    expect(data<SettlementData>(approveRes).status).toBe('APPROVED');

    const payRes = await request(server())
      .patch(`/api/v1/vendor-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PAID', notes: 'Bank transfer reference #9981' });
    expect(payRes.status).toBe(200);
    expect(data<SettlementData>(payRes).status).toBe('PAID');

    const invalidTransitionRes = await request(server())
      .patch(`/api/v1/vendor-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'FAILED' });
    expect(invalidTransitionRes.status).toBe(400);
  });

  it('records a manual adjustment and reflects it in the adjusted net amount', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Adjustment Flow Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'VS 2222');
    const category = await getFishCategory();

    await completeAndPayOrder(
      adminToken,
      customerToken,
      vendor.accessToken,
      driver.accessToken,
      category.id,
      'Adjustment Flow Snapper',
    );

    await request(server())
      .post('/api/v1/vendor-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const mineRes = await request(server())
      .get('/api/v1/vendor-settlements/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    const settlement = data<{ items: SettlementData[] }>(mineRes).items[0]!;

    const adjustmentRes = await request(server())
      .post(`/api/v1/vendor-settlements/${settlement.id}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: -100, reason: 'Partial refund issued for damaged goods' });
    expect(adjustmentRes.status).toBe(201);

    const mineAfterRes = await request(server())
      .get('/api/v1/vendor-settlements/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    const updated = data<{ items: SettlementData[] }>(mineAfterRes).items.find(
      (item) => item.id === settlement.id,
    )!;
    expect(Number(updated.adjustedNetAmount)).toBe(Number(settlement.netAmount) - 100);

    const zeroAdjustmentRes = await request(server())
      .post(`/api/v1/vendor-settlements/${settlement.id}/adjustments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 0, reason: 'This should be rejected' });
    expect(zeroAdjustmentRes.status).toBe(400);
  });

  it("does not leak one vendor's settlements into another vendor's list", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendorA = await createApprovedVendorAndLogin(adminToken, 'Isolation Vendor A');
    const vendorB = await createApprovedVendorAndLogin(adminToken, 'Isolation Vendor B');
    const driver = await createApprovedDriverAndLogin(adminToken, 'VS 3333');
    const category = await getFishCategory();

    const vendorOrderId = await completeAndPayOrder(
      adminToken,
      customerToken,
      vendorA.accessToken,
      driver.accessToken,
      category.id,
      'Isolation Snapper',
    );
    await request(server())
      .post('/api/v1/vendor-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const vendorBMineRes = await request(server())
      .get('/api/v1/vendor-settlements/mine')
      .set('Authorization', `Bearer ${vendorB.accessToken}`);
    const vendorBMine = data<{ items: SettlementData[] }>(vendorBMineRes);
    expect(vendorBMine.items.some((item) => item.vendorOrderId === vendorOrderId)).toBe(false);
  });

  it('rejects settlement generation and administration by non-admins', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Non-Admin Vendor');

    const generateRes = await request(server())
      .post('/api/v1/vendor-settlements/generate')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(generateRes.status).toBe(403);

    const listRes = await request(server())
      .get('/api/v1/vendor-settlements')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(listRes.status).toBe(403);

    const rateConfigRes = await request(server())
      .get('/api/v1/vendor-settlements/commission-rate')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(rateConfigRes.status).toBe(403);
  });

  it('manages the platform commission rate as an admin', async () => {
    const adminToken = await createAdminAndLogin();

    const getRes = await request(server())
      .get('/api/v1/vendor-settlements/commission-rate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);

    const createRes = await request(server())
      .post('/api/v1/vendor-settlements/commission-rate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ commissionRate: 0.12 });
    expect(createRes.status).toBe(201);

    const getAfterRes = await request(server())
      .get('/api/v1/vendor-settlements/commission-rate')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<{ commissionRate: string }>(getAfterRes).commissionRate).toBe('0.12');

    const invalidRes = await request(server())
      .post('/api/v1/vendor-settlements/commission-rate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ commissionRate: 1.5 });
    expect(invalidRes.status).toBe(400);
  });
});
