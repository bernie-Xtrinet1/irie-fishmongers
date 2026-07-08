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
  status: string;
}

interface ProductData {
  id: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

interface VendorOrderData {
  id: string;
  status: string;
}

interface OrderData {
  id: string;
  vendorOrders: VendorOrderData[];
}

interface AvailableDeliveryData {
  vendorOrderId: string;
}

interface DeliveryData {
  id: string;
  vendorOrderId: string;
  stage: string;
}

interface TrackingData {
  stage: string;
  driverFirstName: string;
  latestLocation: { latitude: number; longitude: number } | null;
}

// Each test in this file registers several roles (admin, customer, vendor,
// driver) and drives a vendor order through multiple sequential status
// transitions, well beyond Jest's default 5s per-test timeout.
jest.setTimeout(20_000);

describe('Delivery (e2e)', () => {
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
    // Customers first: cascades Order -> VendorOrder -> OrderItem -> Delivery,
    // freeing the Restrict constraint on Delivery.driverId and VendorOrder.vendorId
    // before the vendor/driver user rows are deleted.
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
        description: 'A product created for Delivery e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  async function createReadyVendorOrder(
    customerToken: string,
    vendorAccessToken: string,
    categoryId: string,
    productName: string,
  ): Promise<{ orderId: string; vendorOrderId: string }> {
    const product = await createProduct(vendorAccessToken, categoryId, productName);

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 })
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

    return { orderId: order.id, vendorOrderId };
  }

  it('supports the full assign -> pick up -> locate -> deliver flow with live tracking', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Delivery E2E Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DE 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Delivery Flow Snapper',
    );

    const trackBeforeAssignment = await request(server())
      .get(`/api/v1/delivery/track/${vendorOrderId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(trackBeforeAssignment.status).toBe(404);

    const availableRes = await request(server())
      .get('/api/v1/delivery/available')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(availableRes.status).toBe(200);
    const available = data<{ items: AvailableDeliveryData[] }>(availableRes);
    expect(available.items.some((item) => item.vendorOrderId === vendorOrderId)).toBe(true);

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    expect(assignRes.status).toBe(201);
    const delivery = data<DeliveryData>(assignRes);
    expect(delivery.stage).toBe('ASSIGNED');

    const vendorOrderAfterAssign = await request(server())
      .get('/api/v1/vendor-orders')
      .query({ status: 'ASSIGNED_TO_DRIVER' })
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    const assignedList = data<{ items: VendorOrderData[] }>(vendorOrderAfterAssign);
    expect(assignedList.items.some((item) => item.id === vendorOrderId)).toBe(true);

    const pickedUpRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'PICKED_UP' });
    expect(pickedUpRes.status).toBe(200);
    expect(data<DeliveryData>(pickedUpRes).stage).toBe('PICKED_UP');

    await request(server())
      .post('/api/v1/drivers/me/location')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ latitude: 17.9714, longitude: -76.7931 })
      .expect(204);

    const trackDuringTransit = await request(server())
      .get(`/api/v1/delivery/track/${vendorOrderId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(trackDuringTransit.status).toBe(200);
    const tracking = data<TrackingData>(trackDuringTransit);
    expect(tracking.stage).toBe('PICKED_UP');
    expect(tracking.driverFirstName).toBe('Dana');
    expect(tracking.latestLocation).toMatchObject({ latitude: 17.9714, longitude: -76.7931 });

    const deliveredRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        action: 'DELIVERED',
        proofType: 'PHOTO',
        proofUrl: 'https://cdn.example.com/proof/photo-1.jpg',
      });
    expect(deliveredRes.status).toBe(200);
    expect(data<DeliveryData>(deliveredRes).stage).toBe('DELIVERED');

    const finalTrack = await request(server())
      .get(`/api/v1/delivery/track/${vendorOrderId}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(data<TrackingData>(finalTrack).stage).toBe('DELIVERED');

    const myDeliveriesRes = await request(server())
      .get('/api/v1/delivery/mine')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(myDeliveriesRes.status).toBe(200);
    const mine = data<{ items: DeliveryData[]; total: number }>(myDeliveriesRes);
    expect(mine.items.some((item) => item.id === delivery.id)).toBe(true);
  });

  it('supports a failed delivery, closing the vendor order without blocking future claims', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Failed Delivery Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DE 2222');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Failed Delivery Snapper',
    );

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    const failedRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'FAILED', failureReason: 'Customer not present at delivery address' });
    expect(failedRes.status).toBe(200);
    expect(data<DeliveryData>(failedRes).stage).toBe('FAILED');

    // Driver is free to claim another delivery once the failed one is closed.
    const { vendorOrderId: secondVendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Second Delivery Snapper',
    );
    const secondAssignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId: secondVendorOrderId });
    expect(secondAssignRes.status).toBe(201);
  });

  it('prevents a driver from claiming a second delivery while one is active', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Busy Driver Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DE 3333');
    const category = await getFishCategory();

    const first = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Busy Driver Snapper One',
    );
    await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId: first.vendorOrderId })
      .expect(201);

    const second = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Busy Driver Snapper Two',
    );
    const secondAssignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId: second.vendorOrderId });
    expect(secondAssignRes.status).toBe(409);
  });

  it('prevents a driver from updating a delivery owned by another driver', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Ownership Delivery Vendor');
    const owningDriver = await createApprovedDriverAndLogin(adminToken, 'DE 4444');
    const otherDriver = await createApprovedDriverAndLogin(adminToken, 'DE 5555');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Ownership Delivery Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${owningDriver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    const res = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${otherDriver.accessToken}`)
      .send({ action: 'PICKED_UP' });
    expect(res.status).toBe(403);
  });

  it("prevents a customer from tracking another customer's delivery", async () => {
    const adminToken = await createAdminAndLogin();
    const ownerToken = await createCustomerAndLogin();
    const otherCustomerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Tracking Ownership Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'DE 6666');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      ownerToken,
      vendor.accessToken,
      category.id,
      'Tracking Ownership Snapper',
    );
    await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId })
      .expect(201);

    const res = await request(server())
      .get(`/api/v1/delivery/track/${vendorOrderId}`)
      .set('Authorization', `Bearer ${otherCustomerToken}`);
    expect(res.status).toBe(403);
  });

  it('blocks a driver pending approval from browsing or claiming deliveries', async () => {
    const email = `driver-pending-${randomUUID()}@example.com`;
    driverUserEmails.push(email);
    await request(server()).post('/api/v1/auth/register').send({
      email,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Penny',
      lastName: 'Pending',
      role: 'DRIVER',
    });
    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: 'StrongPass1' });
    const accessToken = data<SessionData>(loginRes).accessToken;

    await request(server())
      .post('/api/v1/drivers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ licensePlate: 'PP 0001', vehicleType: 'MOTORCYCLE', vehicleOwnership: 'PERSONAL_VEHICLE' })
      .expect(201);

    const availableRes = await request(server())
      .get('/api/v1/delivery/available')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(availableRes.status).toBe(403);

    const locationRes = await request(server())
      .post('/api/v1/drivers/me/location')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ latitude: 17.9714, longitude: -76.7931 });
    expect(locationRes.status).toBe(403);
  });

  it("lists and filters drivers for admins", async () => {
    const adminToken = await createAdminAndLogin();
    const driver = await createApprovedDriverAndLogin(adminToken, 'DE 7777');

    const listRes = await request(server())
      .get('/api/v1/drivers')
      .query({ status: 'APPROVED' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const list = data<{ items: DriverData[]; total: number }>(listRes);
    expect(list.items.some((item) => item.id === driver.driverId)).toBe(true);
    expect(list.items.every((item) => item.status === 'APPROVED')).toBe(true);
  });

  it('rejects unauthenticated access to driver and delivery endpoints', async () => {
    const availableRes = await request(server()).get('/api/v1/delivery/available');
    expect(availableRes.status).toBe(401);

    const registerRes = await request(server())
      .post('/api/v1/drivers')
      .send({ licensePlate: 'ZZ 0000', vehicleType: 'CAR' });
    expect(registerRes.status).toBe(401);
  });
});
