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
interface OrderData {
  id: string;
  vendorOrders: { id: string }[];
}
interface DeliveryData {
  id: string;
}
interface ReviewData {
  id: string;
  authorDisplayName: string;
  verifiedPurchase: boolean;
  rating: number;
  title: string | null;
  body: string;
  productId: string | null;
  productName: string | null;
  createdAt: string;
  editedAt: string | null;
}
interface PaginatedReviewsData {
  items: ReviewData[];
  total: number;
  averageRating: number | null;
}
interface EligibilityData {
  eligible: boolean;
  reason: string | null;
}

// Each test registers several roles and drives a vendor order through the
// real checkout -> accept -> prepare -> ready -> assign -> pickup -> deliver
// -> accept workflow, well beyond Jest's default per-test timeout.
jest.setTimeout(30_000);

describe('Reviews (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const customerEmails: string[] = [];
  const vendorUserEmails: string[] = [];
  const driverUserEmails: string[] = [];
  const adminEmails: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(app.get(ConfigService).getOrThrow<string>('API_PREFIX'));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // ReviewAuditLog.reviewId is Restrict, so audit rows must go before their
    // reviews; Review.vendorOrderId is Restrict, so reviews must be cleared
    // before the customer cascade (Order -> VendorOrder) can run.
    if (vendorUserEmails.length > 0) {
      await prisma.reviewAuditLog.deleteMany({
        where: { review: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
      await prisma.review.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
    }
    if (customerEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: customerEmails } } });
    }
    if (vendorUserEmails.length > 0) {
      await prisma.inventoryEvent.deleteMany({
        where: { product: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
      await prisma.product.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
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

  async function createCustomerAndLogin(
    firstName = 'Bernard',
    lastName = 'Williams',
  ): Promise<{ accessToken: string; email: string }> {
    const email = `customer-${randomUUID()}@example.com`;
    customerEmails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: 'StrongPass1', confirmPassword: 'StrongPass1', firstName, lastName });
    const loginRes = await request(server()).post('/api/v1/auth/login').send({ email, password: 'StrongPass1' });
    return { accessToken: data<SessionData>(loginRes).accessToken, email };
  }

  async function createApprovedVendorAndLogin(adminToken: string, businessName: string): Promise<{ accessToken: string; vendorId: string }> {
    const email = `vendor-${randomUUID()}@example.com`;
    vendorUserEmails.push(email);
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: 'StrongPass1', confirmPassword: 'StrongPass1', firstName: 'Vera', lastName: 'Vendor', role: 'VENDOR' });
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
    await request(server())
      .post('/api/v1/auth/register')
      .send({ email, password: 'StrongPass1', confirmPassword: 'StrongPass1', firstName: 'Dana', lastName: 'Driver', role: 'DRIVER' });
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
    await request(server())
      .patch('/api/v1/drivers/me/availability')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'ONLINE' })
      .expect(200);

    return accessToken;
  }

  async function getFishCategory(): Promise<CategoryData> {
    const res = await request(server()).get('/api/v1/categories');
    return data<CategoryData[]>(res).find((category) => category.slug === 'fish')!;
  }

  async function createProduct(vendorToken: string, categoryId: string, name: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({
        categoryId,
        name,
        description: 'A product created for Reviews e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res).id;
  }

  // Checkout -> vendor accept/prepare/ready. Stops at READY_FOR_PICKUP.
  async function createReadyOrder(
    customerToken: string,
    vendorToken: string,
    productId: string,
  ): Promise<{ orderId: string; vendorOrderId: string }> {
    await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId, quantity: 1 })
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

    for (const step of ['accept', 'preparing', 'ready']) {
      await request(server())
        .patch(`/api/v1/vendor-orders/${vendorOrderId}/${step}`)
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(200);
    }
    return { orderId: order.id, vendorOrderId };
  }

  // Full real workflow: ready order -> assign -> pickup -> deliver ->
  // customer acceptance decision (ACCEPTED or REJECTED).
  async function deliverOrder(
    customerToken: string,
    vendorToken: string,
    driverToken: string,
    productId: string,
    decision: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED',
  ): Promise<{ vendorOrderId: string }> {
    const { vendorOrderId } = await createReadyOrder(customerToken, vendorToken, productId);

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ action: 'PICKED_UP' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ action: 'DELIVERED', proofType: 'PHOTO', proofUrl: 'https://cdn.example.com/proof/a.jpg' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/customer-acceptance`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ decision })
      .expect(200);

    return { vendorOrderId };
  }

  it('lets a customer review a vendor and a product after a real delivery, shown publicly with a masked name', async () => {
    const adminToken = await createAdminAndLogin();
    const customer = await createCustomerAndLogin('Bernard', 'Williams');
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Review Vendor');
    const driverToken = await createApprovedDriverAndLogin(adminToken, 'RV 1111');
    const category = await getFishCategory();
    const productId = await createProduct(vendor.accessToken, category.id, `Review Snapper ${randomUUID()}`);

    const { vendorOrderId } = await deliverOrder(customer.accessToken, vendor.accessToken, driverToken, productId);

    // Eligibility pre-check is true once delivered.
    const eligibilityRes = await request(server())
      .get('/api/v1/reviews/eligibility')
      .query({ vendorOrderId, productId })
      .set('Authorization', `Bearer ${customer.accessToken}`);
    expect(eligibilityRes.status).toBe(200);
    expect(data<EligibilityData>(eligibilityRes).eligible).toBe(true);

    // A vendor-only review and a product review from the same order.
    const vendorReviewRes = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 5, title: 'Excellent', body: 'Very fresh snapper, delivered cold.' });
    expect(vendorReviewRes.status).toBe(201);
    const vendorReview = data<ReviewData>(vendorReviewRes);
    expect(vendorReview.authorDisplayName).toBe('Bernard W.');
    expect(vendorReview.verifiedPurchase).toBe(true);
    expect(vendorReview.productId).toBeNull();

    const productReviewRes = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, productId, rating: 4, body: 'Good size and quality for the price.' });
    expect(productReviewRes.status).toBe(201);

    // Public vendor list: both reviews, average (5 + 4) / 2 = 4.5, no PII.
    const vendorListRes = await request(server()).get(`/api/v1/reviews/vendor/${vendor.vendorId}`);
    expect(vendorListRes.status).toBe(200);
    const vendorList = data<PaginatedReviewsData>(vendorListRes);
    expect(vendorList.total).toBe(2);
    expect(vendorList.averageRating).toBe(4.5);
    for (const item of vendorList.items) {
      expect(item).not.toHaveProperty('authorId');
      expect(item).not.toHaveProperty?.('email');
      expect(JSON.stringify(item)).not.toContain(customer.email);
    }

    // Public product list: only the product review.
    const productListRes = await request(server()).get(`/api/v1/reviews/product/${productId}`);
    const productList = data<PaginatedReviewsData>(productListRes);
    expect(productList.total).toBe(1);
    expect(productList.items[0]?.productName).toContain('Review Snapper');
  });

  it('enforces one review per purchase, rejecting duplicates and racing creates with 409', async () => {
    const adminToken = await createAdminAndLogin();
    const customer = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Dup Vendor');
    const driverToken = await createApprovedDriverAndLogin(adminToken, 'DP 1111');
    const category = await getFishCategory();
    const productId = await createProduct(vendor.accessToken, category.id, `Dup Snapper ${randomUUID()}`);
    const { vendorOrderId } = await deliverOrder(customer.accessToken, vendor.accessToken, driverToken, productId);

    const first = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 5, body: 'First vendor review, only one allowed.' });
    expect(first.status).toBe(201);

    const duplicate = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 3, body: 'Second attempt at a vendor review.' });
    expect(duplicate.status).toBe(409);

    // Two simultaneous product-review creates: exactly one succeeds.
    const bodies = { vendorOrderId, productId, rating: 4, body: 'Concurrent product review attempt.' };
    const [a, b] = await Promise.all([
      request(server()).post('/api/v1/reviews').set('Authorization', `Bearer ${customer.accessToken}`).send(bodies),
      request(server()).post('/api/v1/reviews').set('Authorization', `Bearer ${customer.accessToken}`).send(bodies),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('rejects a review before delivery and enforces ownership and the edit window', async () => {
    const adminToken = await createAdminAndLogin();
    const customer = await createCustomerAndLogin();
    const otherCustomer = await createCustomerAndLogin('Nia', 'Nunez');
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Window Vendor');
    const driverToken = await createApprovedDriverAndLogin(adminToken, 'WN 1111');
    const category = await getFishCategory();
    const productId = await createProduct(vendor.accessToken, category.id, `Window Snapper ${randomUUID()}`);

    // Not-yet-delivered order: review rejected.
    const ready = await createReadyOrder(customer.accessToken, vendor.accessToken, productId);
    const tooEarly = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId: ready.vendorOrderId, rating: 5, body: 'Trying to review before delivery.' });
    expect(tooEarly.status).toBe(400);

    // A separate, fully delivered order to review.
    const productId2 = await createProduct(vendor.accessToken, category.id, `Window Snapper 2 ${randomUUID()}`);
    const { vendorOrderId } = await deliverOrder(customer.accessToken, vendor.accessToken, driverToken, productId2);
    const created = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 5, body: 'A review we will try to edit and mis-edit.' });
    const reviewId = data<ReviewData>(created).id;

    // Another customer cannot edit or delete it.
    await request(server())
      .patch(`/api/v1/reviews/${reviewId}`)
      .set('Authorization', `Bearer ${otherCustomer.accessToken}`)
      .send({ rating: 1 })
      .expect(403);

    // The author can edit within the window.
    await request(server())
      .patch(`/api/v1/reviews/${reviewId}`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ rating: 4, body: 'Edited within the fourteen day window.' })
      .expect(200);

    // Backdate creation beyond 14 days, then editing is rejected.
    await prisma.review.update({
      where: { id: reviewId },
      data: { createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
    });
    await request(server())
      .patch(`/api/v1/reviews/${reviewId}`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ rating: 2 })
      .expect(400);
  });

  it('soft-deletes and restores an author review, and blocks restoring an admin-removed one', async () => {
    const adminToken = await createAdminAndLogin();
    const customer = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Restore Vendor');
    const driverToken = await createApprovedDriverAndLogin(adminToken, 'RS 1111');
    const category = await getFishCategory();
    const productId = await createProduct(vendor.accessToken, category.id, `Restore Snapper ${randomUUID()}`);
    const { vendorOrderId } = await deliverOrder(customer.accessToken, vendor.accessToken, driverToken, productId);

    const created = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 5, body: 'A review to remove and then restore.' });
    const reviewId = data<ReviewData>(created).id;

    // Author soft-delete: disappears from public list, row survives.
    await request(server())
      .delete(`/api/v1/reviews/${reviewId}`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(204);
    const afterDelete = data<PaginatedReviewsData>(
      await request(server()).get(`/api/v1/reviews/vendor/${vendor.vendorId}`),
    );
    expect(afterDelete.items.some((item) => item.id === reviewId)).toBe(false);
    const removedRow = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(removedRow?.moderationStatus).toBe('REMOVED_BY_AUTHOR');

    // Author restore within window: reappears, VISIBLE.
    await request(server())
      .patch(`/api/v1/reviews/${reviewId}/restore`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(200);
    const afterRestore = data<PaginatedReviewsData>(
      await request(server()).get(`/api/v1/reviews/vendor/${vendor.vendorId}`),
    );
    expect(afterRestore.items.some((item) => item.id === reviewId)).toBe(true);

    // An admin-removed review can never be restored by the author.
    await prisma.review.update({ where: { id: reviewId }, data: { moderationStatus: 'REMOVED_BY_ADMIN' } });
    await request(server())
      .patch(`/api/v1/reviews/${reviewId}/restore`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(403);
  });

  it('lets an admin remove a review with a required reason, recording an audit trail and hiding it publicly', async () => {
    interface AdminReviewData {
      id: string;
      moderationStatus: string;
      removalReason: string | null;
      deliveryWasRejected: boolean;
      auditLogs?: { action: string; reason: string | null; actorId: string }[];
    }
    interface AdminListData {
      items: AdminReviewData[];
      total: number;
    }

    const adminToken = await createAdminAndLogin();
    const customer = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Moderation Vendor');
    const driverToken = await createApprovedDriverAndLogin(adminToken, 'MD 1111');
    const category = await getFishCategory();
    const productId = await createProduct(vendor.accessToken, category.id, `Mod Snapper ${randomUUID()}`);
    const { vendorOrderId } = await deliverOrder(customer.accessToken, vendor.accessToken, driverToken, productId);

    // A vendor review (kept) and a product review (to be removed).
    await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ vendorOrderId, rating: 5, body: 'Vendor review that stays visible.' })
      .expect(201);
    const productReview = data<ReviewData>(
      await request(server())
        .post('/api/v1/reviews')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ vendorOrderId, productId, rating: 1, body: 'Product review that will be moderated away.' }),
    );

    // Vendor average before removal: (5 + 1) / 2 = 3.
    const before = data<PaginatedReviewsData>(
      await request(server()).get(`/api/v1/reviews/vendor/${vendor.vendorId}`),
    );
    expect(before.averageRating).toBe(3);

    // Non-admins are blocked from the moderation surface.
    await request(server()).get('/api/v1/admin/reviews').expect(401);
    await request(server())
      .get('/api/v1/admin/reviews')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(403);
    await request(server())
      .post(`/api/v1/admin/reviews/${productReview.id}/remove`)
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ reason: 'not allowed' })
      .expect(403);

    // A reason is mandatory.
    await request(server())
      .post(`/api/v1/admin/reviews/${productReview.id}/remove`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    // Admin removes the product review.
    await request(server())
      .post(`/api/v1/admin/reviews/${productReview.id}/remove`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Rating not supported by the review content' })
      .expect(201);

    // Removing again is rejected - it is already admin-removed.
    await request(server())
      .post(`/api/v1/admin/reviews/${productReview.id}/remove`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'second attempt' })
      .expect(400);

    // Public product list is now empty; vendor average recalculates to 5.
    const productAfter = data<PaginatedReviewsData>(
      await request(server()).get(`/api/v1/reviews/product/${productId}`),
    );
    expect(productAfter.total).toBe(0);
    const vendorAfter = data<PaginatedReviewsData>(
      await request(server()).get(`/api/v1/reviews/vendor/${vendor.vendorId}`),
    );
    expect(vendorAfter.total).toBe(1);
    expect(vendorAfter.averageRating).toBe(5);

    // The removed review still appears in the admin list, flagged.
    const adminList = data<AdminListData>(
      await request(server())
        .get('/api/v1/admin/reviews')
        .query({ moderationStatus: 'REMOVED_BY_ADMIN', vendorId: vendor.vendorId })
        .set('Authorization', `Bearer ${adminToken}`),
    );
    expect(adminList.items.some((item) => item.id === productReview.id)).toBe(true);

    // The detail view carries the audit trail with the reason and actor.
    const detail = data<AdminReviewData>(
      await request(server())
        .get(`/api/v1/admin/reviews/${productReview.id}`)
        .set('Authorization', `Bearer ${adminToken}`),
    );
    expect(detail.moderationStatus).toBe('REMOVED_BY_ADMIN');
    expect(detail.removalReason).toBe('Rating not supported by the review content');
    expect(detail.auditLogs?.length).toBe(1);
    expect(detail.auditLogs?.[0]?.action).toBe('REMOVED_BY_ADMIN');
    expect(detail.auditLogs?.[0]?.reason).toBe('Rating not supported by the review content');

    // The audit row survives independently in the DB.
    const auditRows = await prisma.reviewAuditLog.findMany({ where: { reviewId: productReview.id } });
    expect(auditRows).toHaveLength(1);
  });
});
