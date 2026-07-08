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
  vendorOrders: { id: string; status: string }[];
}

interface DeliveryData {
  id: string;
}

interface SettlementData {
  id: string;
  driverId: string;
  deliveryId: string | null;
  status: string;
  totalPayout: string;
  volumeBonus: string;
  payoutDate: string | null;
}

interface GenerateResultData {
  settlementsCreated: number;
  settlementPeriodStart: string;
  settlementPeriodEnd: string;
}

// Each test registers several roles and drives an order through the full
// checkout -> delivery -> settlement lifecycle, well beyond Jest's default
// 5s per-test timeout.
jest.setTimeout(20_000);

describe('Driver Settlements (e2e)', () => {
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
      await prisma.driverSettlement.deleteMany({
        where: { driver: { user: { email: { in: driverUserEmails } } } },
      });
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
        description: 'A product created for Driver Settlements e2e tests.',
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

  async function completeDeliveryViaHttp(
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

    return delivery.id;
  }

  async function createDeliveredOrderDirectly(
    customerId: string,
    vendorId: string,
    productId: string,
    driverId: string,
    deliveredAt: Date,
  ): Promise<void> {
    const order = await prisma.order.create({
      data: {
        customerId,
        deliveryAddressLine1: '1 Ocean View Road',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551234',
        vendorOrders: {
          create: [
            {
              vendorId,
              subtotal: 500,
              status: 'DELIVERED',
              items: {
                create: [
                  {
                    productId,
                    productName: 'Bulk Snapper',
                    unitPrice: 500,
                    unit: 'PER_POUND',
                    quantity: 1,
                    subtotal: 500,
                  },
                ],
              },
            },
          ],
        },
      },
      include: { vendorOrders: true },
    });

    await prisma.delivery.create({
      data: {
        vendorOrderId: order.vendorOrders[0]!.id,
        driverId,
        assignedAt: deliveredAt,
        pickedUpAt: deliveredAt,
        deliveredAt,
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof/bulk.jpg',
      },
    });
  }

  it('generates a settlement after a completed delivery, then approves and pays it', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Settlement Flow Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DS 1111');
    const category = await getFishCategory();

    const deliveryId = await completeDeliveryViaHttp(
      customerToken,
      vendor.accessToken,
      driver.accessToken,
      category.id,
      'Settlement Flow Snapper',
    );

    // Anchor the settlement to a fixed, deterministic week so this test does
    // not depend on which real-world week it happens to run in.
    const weekStart = '2027-01-04';
    const periodStart = new Date('2027-01-04T05:00:00.000Z');
    await prisma.delivery.update({ where: { id: deliveryId }, data: { deliveredAt: periodStart } });

    const generateRes = await request(server())
      .post('/api/v1/driver-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ weekStart });
    expect(generateRes.status).toBe(201);
    const generateResult = data<GenerateResultData>(generateRes);
    expect(generateResult.settlementsCreated).toBeGreaterThanOrEqual(1);

    const mineRes = await request(server())
      .get('/api/v1/driver-settlements/mine')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(mineRes.status).toBe(200);
    const mine = data<{ items: SettlementData[] }>(mineRes);
    const settlement = mine.items.find((item) => item.deliveryId === deliveryId);
    expect(settlement).toBeDefined();
    expect(settlement!.status).toBe('PENDING');
    expect(Number(settlement!.totalPayout)).toBeGreaterThan(0);

    const adminListRes = await request(server())
      .get('/api/v1/driver-settlements')
      .query({ driverId: driver.driverId })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminListRes.status).toBe(200);
    const adminList = data<{ items: SettlementData[] }>(adminListRes);
    expect(adminList.items.some((item) => item.id === settlement!.id)).toBe(true);

    const approveRes = await request(server())
      .patch(`/api/v1/driver-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });
    expect(approveRes.status).toBe(200);
    expect(data<SettlementData>(approveRes).status).toBe('APPROVED');

    const invalidReplayRes = await request(server())
      .post('/api/v1/driver-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ weekStart });
    expect(invalidReplayRes.status).toBe(201);
    expect(data<GenerateResultData>(invalidReplayRes).settlementsCreated).toBe(0);

    const payRes = await request(server())
      .patch(`/api/v1/driver-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PAID', notes: 'Bank transfer reference #4471' });
    expect(payRes.status).toBe(200);
    const paid = data<SettlementData>(payRes);
    expect(paid.status).toBe('PAID');
    expect(paid.payoutDate).not.toBeNull();

    const rejectedStatusRes = await request(server())
      .patch(`/api/v1/driver-settlements/${settlement!.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'FAILED' });
    expect(rejectedStatusRes.status).toBe(400);
  });

  it('generates a weekly volume bonus once a driver crosses the tier 1 threshold', async () => {
    const adminToken = await createAdminAndLogin();
    await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Volume Bonus Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DS 2222');
    const category = await getFishCategory();

    const customer = await prisma.user.findUniqueOrThrow({
      where: { email: customerEmails[customerEmails.length - 1] },
    });
    const product = await createProduct(vendor.accessToken, category.id, 'Bulk Snapper Base');

    const weekStart = '2027-02-01';
    const periodStart = new Date('2027-02-01T05:00:00.000Z');

    for (let i = 0; i < 20; i += 1) {
      await createDeliveredOrderDirectly(
        customer.id,
        vendor.vendorId,
        product.id,
        driver.driverId,
        new Date(periodStart.getTime() + i * 60_000),
      );
    }

    const generateRes = await request(server())
      .post('/api/v1/driver-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ weekStart });
    expect(generateRes.status).toBe(201);
    expect(data<GenerateResultData>(generateRes).settlementsCreated).toBe(21); // 20 deliveries + 1 bonus row

    const mineRes = await request(server())
      .get('/api/v1/driver-settlements/mine')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .query({ pageSize: 50 });
    const mine = data<{ items: SettlementData[] }>(mineRes);
    const bonusRow = mine.items.find((item) => item.deliveryId === null && Number(item.volumeBonus) > 0);
    expect(bonusRow).toBeDefined();
    expect(Number(bonusRow!.volumeBonus)).toBe(1000);
  });

  it("does not leak one driver's settlements into another driver's list", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Isolation Vendor');
    const driverA = await createApprovedDriverAndLogin(adminToken, 'DS 3333');
    const driverB = await createApprovedDriverAndLogin(adminToken, 'DS 4444');
    const category = await getFishCategory();

    const deliveryId = await completeDeliveryViaHttp(
      customerToken,
      vendor.accessToken,
      driverA.accessToken,
      category.id,
      'Isolation Snapper',
    );
    const weekStart = '2027-03-01';
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { deliveredAt: new Date('2027-03-01T05:00:00.000Z') },
    });
    await request(server())
      .post('/api/v1/driver-settlements/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ weekStart })
      .expect(201);

    const driverBMineRes = await request(server())
      .get('/api/v1/driver-settlements/mine')
      .set('Authorization', `Bearer ${driverB.accessToken}`);
    const driverBMine = data<{ items: SettlementData[] }>(driverBMineRes);
    expect(driverBMine.items.some((item) => item.deliveryId === deliveryId)).toBe(false);
  });

  it('rejects settlement generation and administration by non-admins', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const driver = await createApprovedDriverAndLogin(adminToken, 'DS 5555');

    const generateRes = await request(server())
      .post('/api/v1/driver-settlements/generate')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ weekStart: '2027-01-04' });
    expect(generateRes.status).toBe(403);

    const listRes = await request(server())
      .get('/api/v1/driver-settlements')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(listRes.status).toBe(403);

    const rateConfigRes = await request(server())
      .get('/api/v1/driver-settlements/rate-config')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(rateConfigRes.status).toBe(403);
  });

  it('manages the settlement rate configuration as an admin', async () => {
    const adminToken = await createAdminAndLogin();

    const getRes = await request(server())
      .get('/api/v1/driver-settlements/rate-config')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);

    const validConfig = {
      baseFee: 160,
      distanceCompensationEnabled: true,
      distanceRatePerKm: 22,
      heavyLoadThresholdLbs: 55,
      heavyLoadBonus: 220,
      peakBonus: 110,
      volumeBonusTier1Threshold: 20,
      volumeBonusTier1Amount: 1000,
      volumeBonusTier2Threshold: 40,
      volumeBonusTier2Amount: 3000,
      volumeBonusTier3Threshold: 60,
      volumeBonusTier3Amount: 5000,
    };
    const createRes = await request(server())
      .post('/api/v1/driver-settlements/rate-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validConfig);
    expect(createRes.status).toBe(201);

    const getAfterRes = await request(server())
      .get('/api/v1/driver-settlements/rate-config')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<{ baseFee: string }>(getAfterRes).baseFee).toBe('160');

    const invalidConfig = { ...validConfig, volumeBonusTier2Threshold: 20 };
    const rejectedRes = await request(server())
      .post('/api/v1/driver-settlements/rate-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(invalidConfig);
    expect(rejectedRes.status).toBe(400);
  });
});
