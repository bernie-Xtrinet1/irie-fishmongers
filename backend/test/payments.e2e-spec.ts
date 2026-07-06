import * as bcrypt from 'bcrypt';
import { createHmac, randomUUID } from 'crypto';
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

interface ProductData {
  id: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

interface PaymentData {
  id: string;
  orderId: string;
  provider: string;
  status: string;
  amount: string;
}

interface VendorOrderData {
  id: string;
  vendorId: string;
  status: string;
  subtotal: string;
}

interface OrderData {
  id: string;
  customerId: string;
  vendorOrders: VendorOrderData[];
  payment?: PaymentData;
  paymentRedirectUrl?: string;
}

interface RefundData {
  id: string;
  paymentId: string;
  amount: string;
  status: string;
}

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wiPayApiKey: string;
  const customerEmails: string[] = [];
  const vendorUserEmails: string[] = [];
  const adminEmails: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.setGlobalPrefix(app.get(ConfigService).getOrThrow<string>('API_PREFIX'));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    wiPayApiKey = app.get(ConfigService).getOrThrow<string>('WIPAY_API_KEY');
  });

  afterAll(async () => {
    if (customerEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: customerEmails } } });
    }
    if (vendorUserEmails.length > 0) {
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
    overrides: { name: string; price: number; quantityAvailable: number },
  ): Promise<ProductData> {
    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        categoryId,
        name: overrides.name,
        description: 'A product created for Payments e2e tests.',
        unit: 'PER_POUND',
        price: overrides.price,
        quantityAvailable: overrides.quantityAvailable,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  const deliveryInfo = {
    deliveryAddressLine1: '1 Ocean View Road',
    deliveryParish: 'KINGSTON' as const,
    deliveryPhone: '+18765551234',
  };

  async function checkoutSingleVendorOrder(
    customerToken: string,
    vendorAccessToken: string,
    categoryId: string,
    paymentMethod: 'CASH_ON_DELIVERY' | 'WIPAY',
  ): Promise<OrderData> {
    const product = await createProduct(vendorAccessToken, categoryId, {
      name: `Payments Test Snapper ${randomUUID()}`,
      price: 500,
      quantityAvailable: 10,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 2 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ ...deliveryInfo, paymentMethod });
    return data<OrderData>(checkoutRes);
  }

  it('creates a pending cash-on-delivery payment at checkout and allows immediate vendor acceptance', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'COD Payments Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );

    expect(order.payment?.provider).toBe('CASH_ON_DELIVERY');
    expect(order.payment?.status).toBe('PENDING');

    const vendorOrderId = order.vendorOrders[0]!.id;
    const acceptRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(acceptRes.status).toBe(200);
    expect(data<VendorOrderData>(acceptRes).status).toBe('ACCEPTED');
  });

  it('allows an admin to confirm cash collected on delivery', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'COD Mark Paid Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );
    const paymentId = order.payment!.id;

    const markPaidRes = await request(server())
      .patch(`/api/v1/payments/${paymentId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(markPaidRes.status).toBe(200);
    expect(data<PaymentData>(markPaidRes).status).toBe('PAID');
  });

  it('prevents a non-admin from confirming a cash-on-delivery payment', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'COD Non-Admin Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );

    const res = await request(server())
      .patch(`/api/v1/payments/${order.payment!.id}/mark-paid`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('automatically refunds a paid vendor-order subtotal when the vendor rejects it', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'COD Reject Refund Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );
    const paymentId = order.payment!.id;

    await request(server())
      .patch(`/api/v1/payments/${paymentId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const vendorOrderId = order.vendorOrders[0]!.id;
    const rejectRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/reject`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(rejectRes.status).toBe(200);

    const orderAfterReject = await request(server())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(data<OrderData>(orderAfterReject).payment?.status).toBe('REFUNDED');
  });

  it('allows an admin to issue a partial refund within the remaining balance', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Partial Refund Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );
    const paymentId = order.payment!.id;

    await request(server())
      .patch(`/api/v1/payments/${paymentId}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const refundRes = await request(server())
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 400, reason: 'Administrator-approved exceptional circumstance' });
    expect(refundRes.status).toBe(201);
    expect(data<RefundData>(refundRes).status).toBe('COMPLETED');

    const overRefundRes = await request(server())
      .post(`/api/v1/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 900, reason: 'Administrator-approved exceptional circumstance' });
    expect(overRefundRes.status).toBe(400);
  });

  it('prevents a non-admin from issuing a refund', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Non-Admin Refund Vendor');
    const category = await getFishCategory();

    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );
    await request(server())
      .patch(`/api/v1/payments/${order.payment!.id}/mark-paid`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(server())
      .post(`/api/v1/payments/${order.payment!.id}/refund`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ amount: 100, reason: 'Should not be allowed' });
    expect(res.status).toBe(403);
  });

  it('blocks vendor acceptance until an online payment is confirmed paid, then unblocks it via the WiPay webhook', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'WiPay Gate Vendor');
    const category = await getFishCategory();

    // Checkout as cash-on-delivery (no live gateway available in this environment),
    // then simulate that the order was actually paid for online via WiPay by
    // updating the persisted payment record directly - this isolates the business
    // rule under test (the acceptance gate + webhook handling) from the unrelated
    // concern of reaching a live WiPay sandbox.
    const order = await checkoutSingleVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'CASH_ON_DELIVERY',
    );
    const providerReference = `txn-${randomUUID()}`;
    await prisma.payment.update({
      where: { id: order.payment!.id },
      data: { provider: 'WIPAY', status: 'PENDING', providerReference },
    });

    const vendorOrderId = order.vendorOrders[0]!.id;
    const blockedAcceptRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(blockedAcceptRes.status).toBe(403);

    const rawBody = JSON.stringify({ transaction_id: providerReference, status: 'success' });
    const signature = createHmac('sha256', wiPayApiKey).update(rawBody).digest('hex');

    const webhookRes = await request(server())
      .post('/api/v1/payments/webhooks/wipay')
      .set('Content-Type', 'application/json')
      .set('x-wipay-signature', signature)
      .send(rawBody);
    expect(webhookRes.status).toBe(200);

    const acceptRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(acceptRes.status).toBe(200);
  });

  it('rejects a WiPay webhook with an invalid signature', async () => {
    const rawBody = JSON.stringify({ transaction_id: 'txn-does-not-exist', status: 'success' });

    const res = await request(server())
      .post('/api/v1/payments/webhooks/wipay')
      .set('Content-Type', 'application/json')
      .set('x-wipay-signature', 'not-a-real-signature')
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it('rejects a WiPay webhook with no signature header', async () => {
    const rawBody = JSON.stringify({ transaction_id: 'txn-does-not-exist', status: 'success' });

    const res = await request(server())
      .post('/api/v1/payments/webhooks/wipay')
      .set('Content-Type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(400);
  });
});
