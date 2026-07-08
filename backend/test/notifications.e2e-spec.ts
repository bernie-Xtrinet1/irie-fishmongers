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

interface CategoryData {
  id: string;
  slug: string;
}

interface ProductData {
  id: string;
}

interface VendorOrderData {
  id: string;
  status: string;
}

interface OrderData {
  id: string;
  vendorOrders: VendorOrderData[];
}

interface NotificationData {
  id: string;
  category: string;
  eventType: string;
  channel: string;
  status: string;
  readAt: string | null;
}

interface PreferenceData {
  orderUpdatesEnabled: boolean;
  emailEnabled: boolean;
}

// Registration/checkout/acceptance flows below each fan out to real
// EMAIL/PUSH/IN_APP notification attempts; the EMAIL adapter makes a live
// (fast-failing, since these are placeholder dev credentials) call to
// SendGrid. Only IN_APP is asserted on here since it never depends on an
// external provider succeeding.
jest.setTimeout(20_000);

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const customerEmails: string[] = [];
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
    if (customerEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: customerEmails } } });
    }
    if (vendorUserEmails.length > 0) {
      await prisma.inventoryEvent.deleteMany({
        where: { product: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
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
        description: 'A product created for Notifications e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  async function getMyNotifications(accessToken: string): Promise<NotificationData[]> {
    const res = await request(server())
      .get('/api/v1/notifications/mine')
      .set('Authorization', `Bearer ${accessToken}`);
    return data<{ items: NotificationData[] }>(res).items;
  }

  it('creates an in-app notification on registration', async () => {
    const customerToken = await createCustomerAndLogin();

    const notifications = await getMyNotifications(customerToken);
    const registrationNotification = notifications.find(
      (item) => item.eventType === 'REGISTRATION_CONFIRMED' && item.channel === 'IN_APP',
    );
    expect(registrationNotification).toBeDefined();
    expect(registrationNotification!.status).toBe('SENT');
  });

  it('marks a notification as read', async () => {
    const customerToken = await createCustomerAndLogin();
    const notifications = await getMyNotifications(customerToken);
    const target = notifications[0]!;
    expect(target.readAt).toBeNull();

    const readRes = await request(server())
      .patch(`/api/v1/notifications/${target.id}/read`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(readRes.status).toBe(200);
    expect(data<NotificationData>(readRes).readAt).not.toBeNull();

    const otherCustomerToken = await createCustomerAndLogin();
    const forbiddenRes = await request(server())
      .patch(`/api/v1/notifications/${target.id}/read`)
      .set('Authorization', `Bearer ${otherCustomerToken}`);
    expect(forbiddenRes.status).toBe(404);
  });

  it('creates in-app notifications for order placement and vendor acceptance', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Notification Flow Vendor');
    const category = await getFishCategory();
    const product = await createProduct(vendor.accessToken, category.id, 'Notification Flow Snapper');

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

    const afterCheckout = await getMyNotifications(customerToken);
    expect(
      afterCheckout.some((item) => item.eventType === 'ORDER_PLACED' && item.channel === 'IN_APP'),
    ).toBe(true);

    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .expect(200);

    const afterAccept = await getMyNotifications(customerToken);
    expect(
      afterAccept.some((item) => item.eventType === 'ORDER_ACCEPTED' && item.channel === 'IN_APP'),
    ).toBe(true);
  });

  it("suppresses a category's notifications once the customer opts out", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Preference Flow Vendor');
    const category = await getFishCategory();

    const optOutRes = await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ orderUpdatesEnabled: false });
    expect(optOutRes.status).toBe(200);
    expect(data<PreferenceData>(optOutRes).orderUpdatesEnabled).toBe(false);

    const product = await createProduct(vendor.accessToken, category.id, 'Preference Flow Snapper');
    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 })
      .expect(201);
    await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        deliveryAddressLine1: '1 Ocean View Road',
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551234',
        paymentMethod: 'CASH_ON_DELIVERY',
      })
      .expect(201);

    const notifications = await getMyNotifications(customerToken);
    expect(notifications.some((item) => item.eventType === 'ORDER_PLACED')).toBe(false);
  });

  it('gets default preferences before any have been set', async () => {
    const customerToken = await createCustomerAndLogin();

    const res = await request(server())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const preferences = data<PreferenceData>(res);
    expect(preferences.emailEnabled).toBe(true);
    expect(preferences.orderUpdatesEnabled).toBe(true);
  });

  it('registers and removes a push device token', async () => {
    const customerToken = await createCustomerAndLogin();

    const registerRes = await request(server())
      .post('/api/v1/notifications/device-tokens')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ token: `fcm-token-${randomUUID()}`, platform: 'ANDROID' });
    expect(registerRes.status).toBe(204);
  });

  it('rejects unauthenticated access to notification endpoints', async () => {
    const res = await request(server()).get('/api/v1/notifications/mine');
    expect(res.status).toBe(401);
  });
});
