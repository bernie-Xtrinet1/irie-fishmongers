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

interface ProductData {
  id: string;
  quantityAvailable: number;
}

interface CategoryData {
  id: string;
  slug: string;
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
}

interface CartData {
  id: string;
  items: { id: string; productId: string; quantity: number }[];
}

describe('Orders (e2e)', () => {
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
    // Delete customers first: Order.customer cascades away Order/VendorOrder/
    // OrderItem rows. Only once those are gone is it safe to delete the vendor
    // users (VendorOrder.vendor is onDelete: Restrict).
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
        description: 'A product created for Orders e2e tests.',
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

  it('supports the full multi-vendor checkout -> accept -> preparing -> ready flow, and vendor rejection with stock restoration', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendorA = await createApprovedVendorAndLogin(adminToken, 'Vendor A Seafood');
    const vendorB = await createApprovedVendorAndLogin(adminToken, 'Vendor B Seafood');
    const category = await getFishCategory();

    const productA = await createProduct(vendorA.accessToken, category.id, {
      name: 'Vendor A Snapper',
      price: 500,
      quantityAvailable: 10,
    });
    const productB = await createProduct(vendorB.accessToken, category.id, {
      name: 'Vendor B Shrimp',
      price: 800,
      quantityAvailable: 10,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: productA.id, quantity: 2 })
      .expect(201);
    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: productB.id, quantity: 1 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);
    expect(checkoutRes.status).toBe(201);
    const order = data<OrderData>(checkoutRes);
    expect(order.vendorOrders).toHaveLength(2);

    const vendorOrderA = order.vendorOrders.find((vo) => vo.vendorId === vendorA.vendorId)!;
    const vendorOrderB = order.vendorOrders.find((vo) => vo.vendorId === vendorB.vendorId)!;
    expect(vendorOrderA.subtotal).toBe('1000');
    expect(vendorOrderB.subtotal).toBe('800');

    const productAAfterCheckout = await request(server()).get(`/api/v1/products/${productA.id}`);
    expect(data<ProductData>(productAAfterCheckout).quantityAvailable).toBe(8);
    const productBAfterCheckout = await request(server()).get(`/api/v1/products/${productB.id}`);
    expect(data<ProductData>(productBAfterCheckout).quantityAvailable).toBe(9);

    const cartAfterCheckout = await request(server())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(data<CartData>(cartAfterCheckout).items).toHaveLength(0);

    const skipToReadyRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderA.id}/ready`)
      .set('Authorization', `Bearer ${vendorA.accessToken}`);
    expect(skipToReadyRes.status).toBe(400);

    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderA.id}/accept`)
      .set('Authorization', `Bearer ${vendorA.accessToken}`)
      .expect(200);
    await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderA.id}/preparing`)
      .set('Authorization', `Bearer ${vendorA.accessToken}`)
      .expect(200);
    const readyRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderA.id}/ready`)
      .set('Authorization', `Bearer ${vendorA.accessToken}`);
    expect(readyRes.status).toBe(200);
    expect(data<VendorOrderData>(readyRes).status).toBe('READY_FOR_PICKUP');

    const rejectRes = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderB.id}/reject`)
      .set('Authorization', `Bearer ${vendorB.accessToken}`);
    expect(rejectRes.status).toBe(200);
    expect(data<VendorOrderData>(rejectRes).status).toBe('REJECTED');

    const productBAfterReject = await request(server()).get(`/api/v1/products/${productB.id}`);
    expect(data<ProductData>(productBAfterReject).quantityAvailable).toBe(10);

    const cancelWholeOrderRes = await request(server())
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(cancelWholeOrderRes.status).toBe(400);
  });

  it('allows a customer to cancel a still-pending order and restores stock', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Cancel Test Vendor');
    const category = await getFishCategory();
    const product = await createProduct(vendor.accessToken, category.id, {
      name: 'Cancel Test Snapper',
      price: 500,
      quantityAvailable: 10,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 3 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);
    const order = data<OrderData>(checkoutRes);

    const cancelRes = await request(server())
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(cancelRes.status).toBe(200);
    expect(data<OrderData>(cancelRes).vendorOrders[0]?.status).toBe('CANCELLED');

    const productAfterCancel = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(data<ProductData>(productAfterCancel).quantityAvailable).toBe(10);
  });

  it('rejects checkout when requested quantity exceeds available stock', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Oversell Test Vendor');
    const category = await getFishCategory();
    const product = await createProduct(vendor.accessToken, category.id, {
      name: 'Oversell Test Snapper',
      price: 500,
      quantityAvailable: 2,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 5 })
      .expect(201);

    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);
    expect(checkoutRes.status).toBe(409);
  });

  it('rejects checkout with an empty cart', async () => {
    const customerToken = await createCustomerAndLogin();
    const res = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated checkout', async () => {
    const res = await request(server()).post('/api/v1/orders/checkout').send(deliveryInfo);
    expect(res.status).toBe(401);
  });

  it('prevents a customer from accessing another customer’s order', async () => {
    const adminToken = await createAdminAndLogin();
    const ownerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Ownership Test Vendor');
    const category = await getFishCategory();
    const product = await createProduct(vendor.accessToken, category.id, {
      name: 'Ownership Test Snapper',
      price: 500,
      quantityAvailable: 10,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ productId: product.id, quantity: 1 })
      .expect(201);
    const checkoutRes = await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(deliveryInfo);
    const order = data<OrderData>(checkoutRes);

    const otherCustomerToken = await createCustomerAndLogin();
    const res = await request(server())
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${otherCustomerToken}`);
    expect(res.status).toBe(403);
  });

  it('prevents a vendor from acting on another vendor’s order', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const owningVendor = await createApprovedVendorAndLogin(adminToken, 'Owning Vendor');
    const otherVendor = await createApprovedVendorAndLogin(adminToken, 'Other Vendor');
    const category = await getFishCategory();
    const product = await createProduct(owningVendor.accessToken, category.id, {
      name: 'Vendor Ownership Test Snapper',
      price: 500,
      quantityAvailable: 10,
    });

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

    const res = await request(server())
      .patch(`/api/v1/vendor-orders/${vendorOrderId}/accept`)
      .set('Authorization', `Bearer ${otherVendor.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("lists a vendor's incoming orders filtered by status", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Listing Test Vendor');
    const category = await getFishCategory();
    const product = await createProduct(vendor.accessToken, category.id, {
      name: 'Listing Test Snapper',
      price: 500,
      quantityAvailable: 10,
    });

    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 })
      .expect(201);
    await request(server())
      .post('/api/v1/orders/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(deliveryInfo);

    const listRes = await request(server())
      .get('/api/v1/vendor-orders')
      .query({ status: 'PENDING' })
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(listRes.status).toBe(200);
    const listBody = data<{ items: VendorOrderData[]; total: number }>(listRes);
    expect(listBody.items.every((item) => item.status === 'PENDING')).toBe(true);
    expect(listBody.total).toBeGreaterThanOrEqual(1);
  });
});
