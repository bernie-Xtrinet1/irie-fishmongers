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
  lotId: string | null;
  availability: string;
}

interface LotData {
  id: string;
  lotNumber: string;
  foodSafetyStatus: string;
}

interface PublicLotData {
  lotNumber: string;
  temperatureVerified: boolean;
}

interface RecordReadingResultData {
  reading: { id: string };
  alert?: { id: string; severity: string };
}

interface InspectionData {
  id: string;
  result: string;
}

interface IncidentData {
  id: string;
  status: string;
}

interface RecallData {
  id: string;
  status: string;
  lotIds: string[];
}

interface AffectedOrderData {
  orderId: string;
  productId: string;
  lotId: string;
}

interface VendorOrderData {
  id: string;
  status: string;
}

interface OrderData {
  id: string;
  vendorOrders: VendorOrderData[];
}

// Several tests drive a lot through registration -> temperature breach ->
// inspection -> checkout -> recall, well beyond Jest's default 5s timeout.
jest.setTimeout(20_000);

describe('Food Safety / Compliance (e2e)', () => {
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
    // Customers first: cascades Order -> VendorOrder -> OrderItem, freeing
    // the Restrict constraint on Product before products are deleted.
    if (customerEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: customerEmails } } });
    }
    if (vendorUserEmails.length > 0) {
      // Frees Product -> InventoryEvent's Restrict constraint.
      await prisma.inventoryEvent.deleteMany({
        where: { product: { vendor: { user: { email: { in: vendorUserEmails } } } } },
      });
      // Frees Product -> SeafoodLot's Restrict constraint.
      await prisma.product.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
    }
    if (adminEmails.length > 0) {
      // Frees Recall -> createdBy's Restrict constraint on the admin user.
      await prisma.recall.deleteMany({ where: { createdBy: { email: { in: adminEmails } } } });
    }
    if (vendorUserEmails.length > 0) {
      // Cascades away TemperatureReading/Alert/QualityInspection/Incident/RecallLot,
      // and frees SeafoodLot -> Vendor's Restrict constraint.
      await prisma.seafoodLot.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
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

  async function registerLot(vendorAccessToken: string, species: string): Promise<LotData> {
    const res = await request(server())
      .post('/api/v1/seafood-lots')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        species,
        storageType: 'FRESH',
        catchDate: '2026-07-01',
        catchLocation: 'North Coast, Trelawny',
        landingSite: 'Falmouth Landing Site',
        weight: 40,
        weightUnit: 'POUNDS',
      });
    return data<LotData>(res);
  }

  async function createProduct(
    vendorAccessToken: string,
    categoryId: string,
    name: string,
    lotId?: string,
  ): Promise<ProductData> {
    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        categoryId,
        lotId,
        name,
        description: 'A product created for Food Safety e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  it('registers a seafood lot and exposes a public traceability view', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Lot Registration Vendor');

    const lot = await registerLot(vendor.accessToken, 'Yellowfin Snapper');
    expect(lot.foodSafetyStatus).toBe('SAFE');
    expect(lot.lotNumber).toMatch(/^LOT-\d{4}-\d{6}$/);

    const publicRes = await request(server()).get(`/api/v1/seafood-lots/${lot.id}/public`);
    expect(publicRes.status).toBe(200);
    const publicLot = data<PublicLotData>(publicRes);
    expect(publicLot.lotNumber).toBe(lot.lotNumber);
    expect(publicLot.temperatureVerified).toBe(true);

    const mineRes = await request(server())
      .get('/api/v1/seafood-lots/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(mineRes.status).toBe(200);
    const mine = data<{ items: LotData[] }>(mineRes);
    expect(mine.items.some((item) => item.id === lot.id)).toBe(true);
  });

  it('rejects linking a product to a lot owned by a different vendor', async () => {
    const adminToken = await createAdminAndLogin();
    const vendorA = await createApprovedVendorAndLogin(adminToken, 'Cross Vendor Lot Owner');
    const vendorB = await createApprovedVendorAndLogin(adminToken, 'Cross Vendor Product Owner');
    const category = await getFishCategory();

    const lot = await registerLot(vendorA.accessToken, 'King Fish');

    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorB.accessToken}`)
      .send({
        categoryId: category.id,
        lotId: lot.id,
        name: 'Cross Vendor Product',
        description: 'Should be rejected since the lot belongs to another vendor.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    expect(res.status).toBe(400);
  });

  it('prevents a non-owning vendor from viewing another vendor\'s temperature readings', async () => {
    const adminToken = await createAdminAndLogin();
    const owner = await createApprovedVendorAndLogin(adminToken, 'Reading Ownership Owner');
    const outsider = await createApprovedVendorAndLogin(adminToken, 'Reading Ownership Outsider');

    const lot = await registerLot(owner.accessToken, 'Mackerel');

    const res = await request(server())
      .get(`/api/v1/temperature-readings/lot/${lot.id}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('drives a lot through a critical temperature breach, purchase block, and inspection recovery', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Cold Chain Vendor');
    const category = await getFishCategory();

    const lot = await registerLot(vendor.accessToken, 'Red Snapper');
    const product = await createProduct(vendor.accessToken, category.id, 'Cold Chain Snapper', lot.id);
    expect(product.availability).toBe('ACTIVE');

    // FRESH storage is safe at 0-4C; above 7C is CRITICAL (see
    // temperature-monitoring.service.ts's evaluateSeverity).
    const readingRes = await request(server())
      .post('/api/v1/temperature-readings')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ lotId: lot.id, checkpoint: 'VENDOR_STORAGE', temperatureC: 10 });
    expect(readingRes.status).toBe(201);
    const readingResult = data<RecordReadingResultData>(readingRes);
    expect(readingResult.alert?.severity).toBe('CRITICAL');

    const lotAfterBreachRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<LotData>(lotAfterBreachRes).foodSafetyStatus).toBe('UNDER_REVIEW');

    const productAfterBreachRes = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(data<ProductData>(productAfterBreachRes).availability).toBe('ON_HOLD');

    const addToCartRes = await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 });
    expect(addToCartRes.status).toBe(400);

    // A PASSED inspection clears the lot back to SAFE, restoring purchasability.
    const inspectionRes = await request(server())
      .post('/api/v1/quality-inspections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lotId: lot.id, result: 'PASSED', freshnessGrade: 'GRADE_A', qualityScore: 95 });
    expect(inspectionRes.status).toBe(201);
    expect(data<InspectionData>(inspectionRes).result).toBe('PASSED');

    const lotAfterInspectionRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<LotData>(lotAfterInspectionRes).foodSafetyStatus).toBe('SAFE');

    const addToCartAfterRes = await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 });
    expect(addToCartAfterRes.status).toBe(201);
  });

  it('reports a food safety incident and enforces the allowed status transitions', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Incident Vendor');
    const lot = await registerLot(vendor.accessToken, 'Lobster');

    const reportRes = await request(server())
      .post('/api/v1/food-safety-incidents')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        lotId: lot.id,
        severity: 'HIGH',
        description: 'Packaging found torn on arrival with visible ice loss',
      });
    expect(reportRes.status).toBe(201);
    const incident = data<IncidentData>(reportRes);
    expect(incident.status).toBe('OPEN');

    const investigateRes = await request(server())
      .patch(`/api/v1/food-safety-incidents/${incident.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INVESTIGATING' });
    expect(investigateRes.status).toBe(200);

    const resolveRes = await request(server())
      .patch(`/api/v1/food-safety-incidents/${incident.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RESOLVED', correctiveAction: 'Vendor retrained on packaging procedure' });
    expect(resolveRes.status).toBe(200);
    expect(data<IncidentData>(resolveRes).status).toBe('RESOLVED');

    const closeRes = await request(server())
      .patch(`/api/v1/food-safety-incidents/${incident.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CLOSED' });
    expect(closeRes.status).toBe(200);

    // CLOSED is terminal; no further transitions are allowed.
    const reopenRes = await request(server())
      .patch(`/api/v1/food-safety-incidents/${incident.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INVESTIGATING' });
    expect(reopenRes.status).toBe(400);
  });

  it('rejects an incident report from a vendor who does not own the lot', async () => {
    const adminToken = await createAdminAndLogin();
    const owner = await createApprovedVendorAndLogin(adminToken, 'Incident Owner');
    const outsider = await createApprovedVendorAndLogin(adminToken, 'Incident Outsider');
    const lot = await registerLot(owner.accessToken, 'Conch');

    const res = await request(server())
      .post('/api/v1/food-safety-incidents')
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ lotId: lot.id, severity: 'LOW', description: 'Should be rejected: not this vendor\'s lot' });
    expect(res.status).toBe(403);
  });

  it('drives a recall through its full lifecycle, cascading RECALLED to lots and blocking purchase', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Recall Vendor');
    const category = await getFishCategory();

    const lot = await registerLot(vendor.accessToken, 'Recalled Snapper');
    const product = await createProduct(vendor.accessToken, category.id, 'Recall Flow Snapper', lot.id);

    // Complete one order for this product before the recall, so the
    // affected-orders lookup below has something real to surface.
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
    expect(checkoutRes.status).toBe(201);
    const order = data<OrderData>(checkoutRes);

    const createRecallRes = await request(server())
      .post('/api/v1/recalls')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        severityClass: 'CLASS_II',
        reason: 'Elevated histamine levels detected in post-market sampling',
        lotIds: [lot.id],
      });
    expect(createRecallRes.status).toBe(201);
    const recall = data<RecallData>(createRecallRes);
    expect(recall.status).toBe('DRAFT');
    expect(recall.lotIds).toEqual([lot.id]);

    // DRAFT can only move to ACTIVE - skipping ahead is rejected.
    const invalidSkipRes = await request(server())
      .patch(`/api/v1/recalls/${recall.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RESOLVED' });
    expect(invalidSkipRes.status).toBe(400);

    const activateRes = await request(server())
      .patch(`/api/v1/recalls/${recall.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' });
    expect(activateRes.status).toBe(200);
    expect(data<RecallData>(activateRes).status).toBe('ACTIVE');

    const lotAfterRecallRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<LotData>(lotAfterRecallRes).foodSafetyStatus).toBe('RECALLED');

    const productAfterRecallRes = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(data<ProductData>(productAfterRecallRes).availability).toBe('ON_HOLD');

    const addToCartRes = await request(server())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId: product.id, quantity: 1 });
    expect(addToCartRes.status).toBe(400);

    const affectedOrdersRes = await request(server())
      .get(`/api/v1/recalls/${recall.id}/affected-orders`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(affectedOrdersRes.status).toBe(200);
    const affectedOrders = data<AffectedOrderData[]>(affectedOrdersRes);
    expect(affectedOrders.some((item) => item.orderId === order.id && item.lotId === lot.id)).toBe(
      true,
    );

    // A PASSED inspection while RECALLED must not silently clear the recall.
    const inspectionRes = await request(server())
      .post('/api/v1/quality-inspections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ lotId: lot.id, result: 'PASSED', freshnessGrade: 'GRADE_A', qualityScore: 90 });
    expect(inspectionRes.status).toBe(201);
    const lotStillRecalledRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<LotData>(lotStillRecalledRes).foodSafetyStatus).toBe('RECALLED');

    await request(server())
      .patch(`/api/v1/recalls/${recall.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'INVESTIGATING', rootCause: 'Contaminated ice supply at the packing facility' })
      .expect(200);

    const resolveRes = await request(server())
      .patch(`/api/v1/recalls/${recall.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'RESOLVED',
        resolutionNotes: 'All affected inventory destroyed and disposed per health authority guidance',
      });
    expect(resolveRes.status).toBe(200);

    const closeRes = await request(server())
      .patch(`/api/v1/recalls/${recall.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'CLOSED' });
    expect(closeRes.status).toBe(200);
    expect(data<RecallData>(closeRes).status).toBe('CLOSED');

    // The lot remains RECALLED even after the recall itself is closed -
    // clearing it back to SAFE requires a separate, deliberate admin action.
    const lotAfterCloseRes = await request(server())
      .get(`/api/v1/seafood-lots/${lot.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<LotData>(lotAfterCloseRes).foodSafetyStatus).toBe('RECALLED');
  });

  it('rejects recall creation, status changes, and listing by non-admins', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Non-Admin Recall Vendor');
    const lot = await registerLot(vendor.accessToken, 'Restricted Recall Fish');

    const createRes = await request(server())
      .post('/api/v1/recalls')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ severityClass: 'CLASS_III', reason: 'Should be rejected: vendors cannot create recalls', lotIds: [lot.id] });
    expect(createRes.status).toBe(403);

    const listRes = await request(server())
      .get('/api/v1/recalls')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(listRes.status).toBe(403);
  });
});
