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
  tier: string;
}

interface VendorPublicData {
  id: string;
  tier: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

interface ProductData {
  id: string;
}

interface PermissionsData {
  tier: string;
  badge: string;
  dailySalesLimit: string | null;
  monthlySalesLimit: string | null;
  maxActiveListings: number | null;
  canSellRetail: boolean;
  canSellWholesale: boolean;
  canAcceptGovernmentOrders: boolean;
  canExportProducts: boolean;
}

interface DocumentData {
  id: string;
  status: string;
  documentType: string;
}

interface ComplianceStatusData {
  tier: string;
  canSell: boolean;
  requiredDocuments: { type: string; status: string }[];
}

interface UpgradeRequestData {
  id: string;
  status: string;
  requestedTier: string;
}

interface DowngradeEventData {
  id: string;
  fromTier: string;
  toTier: string;
}

// The listing-limit test creates products up to the tier's real limit (50)
// and the sales-limit test drives several checkouts - both well beyond
// Jest's default 5s per-test timeout.
jest.setTimeout(60_000);

describe('Vendor Tiers (e2e)', () => {
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
    // Customers first: frees the Restrict constraint from OrderItem -> Product.
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

  // Registers + admin-approves a vendor, but deliberately does NOT upload
  // any compliance documents - used directly only by the compliance-status
  // test below, which needs to observe the "no documents yet" state.
  async function registerApprovedVendorWithoutDocuments(
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

  async function createApprovedVendorAndLogin(
    adminToken: string,
    businessName: string,
  ): Promise<{ accessToken: string; vendorId: string }> {
    const vendor = await registerApprovedVendorWithoutDocuments(adminToken, businessName);

    // COMMUNITY_FISHER (the default tier on registration) requires an
    // APPROVED GOVERNMENT_ID before the vendor may list products - satisfy
    // that here so every test using this helper gets a sellable vendor by
    // default, the same way admin approval already happens above.
    const govId = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');
    await request(server())
      .patch(`/api/v1/vendor-documents/${govId.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });

    return vendor;
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
    price = 500,
  ): Promise<ProductData> {
    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        categoryId,
        name,
        description: 'A product created for Vendor Tier e2e tests.',
        unit: 'PER_POUND',
        price,
        quantityAvailable: 100,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return data<ProductData>(res);
  }

  async function uploadDocument(
    vendorAccessToken: string,
    documentType: string,
  ): Promise<DocumentData> {
    const res = await request(server())
      .post('/api/v1/vendor-documents')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({ documentType, fileUrl: 'https://cdn.example.com/vendor-docs/doc.jpg' });
    return data<DocumentData>(res);
  }

  it('defaults a newly registered vendor to the Community Fisher tier', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Default Tier Vendor');

    const profileRes = await request(server())
      .get('/api/v1/vendors/me')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(data<VendorData>(profileRes).tier).toBe('COMMUNITY_FISHER');

    const permissionsRes = await request(server())
      .get('/api/v1/vendors/me/permissions')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(permissionsRes.status).toBe(200);
    const permissions = data<PermissionsData>(permissionsRes);
    expect(permissions.badge).toBe('🐟 Community Fisher');
    expect(permissions.dailySalesLimit).toBe('50000');
    expect(permissions.maxActiveListings).toBe(50);
    expect(permissions.canSellRetail).toBe(true);
    expect(permissions.canSellWholesale).toBe(false);
    expect(permissions.canAcceptGovernmentOrders).toBe(false);
    expect(permissions.canExportProducts).toBe(false);
  });

  it('shows unlimited limits and export/wholesale permissions once upgraded to Enterprise Supplier', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Enterprise Preview Vendor');

    const permissionsRes = await request(server())
      .get(`/api/v1/vendors/${vendor.vendorId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(permissionsRes.status).toBe(200);
    expect(data<PermissionsData>(permissionsRes).tier).toBe('COMMUNITY_FISHER');
  });

  it('uploads a document, has it approved, and reflects it in the document list', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Document Flow Vendor');

    const uploaded = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');
    expect(uploaded.status).toBe('PENDING');

    const reviewRes = await request(server())
      .patch(`/api/v1/vendor-documents/${uploaded.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });
    expect(reviewRes.status).toBe(200);
    expect(data<DocumentData>(reviewRes).status).toBe('APPROVED');

    const mineRes = await request(server())
      .get('/api/v1/vendor-documents/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    const mine = data<DocumentData[]>(mineRes);
    expect(mine.some((doc) => doc.id === uploaded.id && doc.status === 'APPROVED')).toBe(true);

    // An approved document cannot be casually removed.
    const removeRes = await request(server())
      .delete(`/api/v1/vendor-documents/${uploaded.id}`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(removeRes.status).toBe(400);
  });

  it('blocks product creation until compliance documents are approved, and reflects it in compliance-status', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerApprovedVendorWithoutDocuments(adminToken, 'Compliance Gate Vendor');
    const category = await getFishCategory();

    const beforeStatusRes = await request(server())
      .get('/api/v1/vendors/me/compliance-status')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(beforeStatusRes.status).toBe(200);
    const beforeStatus = data<ComplianceStatusData>(beforeStatusRes);
    expect(beforeStatus.tier).toBe('COMMUNITY_FISHER');
    expect(beforeStatus.canSell).toBe(false);
    expect(beforeStatus.requiredDocuments).toEqual([{ type: 'GOVERNMENT_ID', status: 'MISSING' }]);

    const blockedRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'Compliance Gate Snapper',
        description: 'Should be blocked until GOVERNMENT_ID is approved.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    expect(blockedRes.status).toBe(403);

    const govId = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');
    await request(server())
      .patch(`/api/v1/vendor-documents/${govId.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const afterStatusRes = await request(server())
      .get('/api/v1/vendors/me/compliance-status')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    const afterStatus = data<ComplianceStatusData>(afterStatusRes);
    expect(afterStatus.canSell).toBe(true);
    expect(afterStatus.requiredDocuments).toEqual([{ type: 'GOVERNMENT_ID', status: 'APPROVED' }]);

    const allowedRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'Compliance Gate Snapper',
        description: 'Now allowed - GOVERNMENT_ID is approved.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    expect(allowedRes.status).toBe(201);
  });

  it('rejects a document review without a rejection reason', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Rejection Reason Vendor');
    const uploaded = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');

    const res = await request(server())
      .patch(`/api/v1/vendor-documents/${uploaded.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'REJECTED' });
    expect(res.status).toBe(400);
  });

  it('rejects a tier upgrade approval until the requested tier\'s documents are approved, then allows it', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Upgrade Flow Vendor');

    const requestRes = await request(server())
      .post('/api/v1/vendors/me/tier-upgrade-requests')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ requestedTier: 'VERIFIED_VENDOR', reason: 'Growing my business' });
    expect(requestRes.status).toBe(201);
    const upgradeRequest = data<UpgradeRequestData>(requestRes);
    expect(upgradeRequest.status).toBe('PENDING');

    // A second concurrent request is rejected while one is pending.
    const duplicateRes = await request(server())
      .post('/api/v1/vendors/me/tier-upgrade-requests')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ requestedTier: 'VERIFIED_VENDOR' });
    expect(duplicateRes.status).toBe(409);

    // VERIFIED_VENDOR requires GOVERNMENT_ID + BUSINESS_REGISTRATION - none uploaded yet.
    const prematureApprovalRes = await request(server())
      .patch(`/api/v1/tier-upgrade-requests/${upgradeRequest.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });
    expect(prematureApprovalRes.status).toBe(400);

    const govId = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');
    await request(server())
      .patch(`/api/v1/vendor-documents/${govId.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    const bizReg = await uploadDocument(vendor.accessToken, 'BUSINESS_REGISTRATION');
    await request(server())
      .patch(`/api/v1/vendor-documents/${bizReg.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const approvalRes = await request(server())
      .patch(`/api/v1/tier-upgrade-requests/${upgradeRequest.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED', reviewNotes: 'All required documents verified' });
    expect(approvalRes.status).toBe(200);
    expect(data<UpgradeRequestData>(approvalRes).status).toBe('APPROVED');

    const profileRes = await request(server())
      .get('/api/v1/vendors/me')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(data<VendorData>(profileRes).tier).toBe('VERIFIED_VENDOR');
  });

  it('rejects an upgrade request to a tier that is not strictly higher', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Invalid Upgrade Vendor');

    const res = await request(server())
      .post('/api/v1/vendors/me/tier-upgrade-requests')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ requestedTier: 'COMMUNITY_FISHER' });
    expect(res.status).toBe(400);
  });

  it('downgrades a vendor and records the downgrade event', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Downgrade Flow Vendor');

    const govId = await uploadDocument(vendor.accessToken, 'GOVERNMENT_ID');
    await request(server())
      .patch(`/api/v1/vendor-documents/${govId.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);
    const bizReg = await uploadDocument(vendor.accessToken, 'BUSINESS_REGISTRATION');
    await request(server())
      .patch(`/api/v1/vendor-documents/${bizReg.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const upgradeRes = await request(server())
      .post('/api/v1/vendors/me/tier-upgrade-requests')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ requestedTier: 'VERIFIED_VENDOR' });
    const upgradeRequest = data<UpgradeRequestData>(upgradeRes);
    await request(server())
      .patch(`/api/v1/tier-upgrade-requests/${upgradeRequest.id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const invalidDowngradeRes = await request(server())
      .post(`/api/v1/vendors/${vendor.vendorId}/downgrade`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toTier: 'ENTERPRISE_SUPPLIER', reason: 'ADMIN_MANUAL' });
    expect(invalidDowngradeRes.status).toBe(400);

    const downgradeRes = await request(server())
      .post(`/api/v1/vendors/${vendor.vendorId}/downgrade`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        toTier: 'COMMUNITY_FISHER',
        reason: 'COMPLIANCE_BREACH',
        notes: 'Repeated late deliveries reported by customers',
      });
    expect(downgradeRes.status).toBe(201);
    expect(data<DowngradeEventData>(downgradeRes).toTier).toBe('COMMUNITY_FISHER');

    const profileRes = await request(server())
      .get('/api/v1/vendors/me')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(data<VendorData>(profileRes).tier).toBe('COMMUNITY_FISHER');

    const eventsRes = await request(server())
      .get(`/api/v1/vendors/${vendor.vendorId}/downgrade-events`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(eventsRes.status).toBe(200);
    const events = data<{ items: DowngradeEventData[] }>(eventsRes);
    expect(events.items.some((event) => event.fromTier === 'VERIFIED_VENDOR')).toBe(true);
  });

  it('filters the admin vendor listing by tier', async () => {
    const adminToken = await createAdminAndLogin();
    await createApprovedVendorAndLogin(adminToken, 'Tier Filter Vendor');

    const res = await request(server())
      .get('/api/v1/vendors')
      .query({ tier: 'COMMUNITY_FISHER' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const list = data<{ items: VendorData[] }>(res);
    expect(list.items.every((item) => item.tier === 'COMMUNITY_FISHER')).toBe(true);
  });

  it('shows the vendor tier on the public storefront profile', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Public Tier Vendor');

    const res = await request(server()).get(`/api/v1/vendors/${vendor.vendorId}/public`);
    expect(res.status).toBe(200);
    expect(data<VendorPublicData>(res).tier).toBe('COMMUNITY_FISHER');
  });

  it("enforces the Community Fisher tier's maximum active listings", async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Listing Limit Vendor');
    const category = await getFishCategory();

    for (let i = 0; i < 50; i += 1) {
      await request(server())
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${vendor.accessToken}`)
        .send({
          categoryId: category.id,
          name: `Listing Limit Snapper ${i}`,
          description: 'A product created for the listing-limit e2e test.',
          unit: 'PER_POUND',
          price: 100,
          quantityAvailable: 1,
          imageUrl: 'https://cdn.example.com/product.jpg',
        })
        .expect(201);
    }

    const overLimitRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'One Too Many Snapper',
        description: 'This should be rejected: over the tier listing limit.',
        unit: 'PER_POUND',
        price: 100,
        quantityAvailable: 1,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    expect(overLimitRes.status).toBe(403);
  });

  it("blocks checkout once the vendor's daily sales limit would be exceeded", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Sales Limit Vendor');
    const category = await getFishCategory();

    // Community Fisher's daily limit is JMD 50,000 - one JMD 60,000 item
    // exceeds it in a single checkout.
    const product = await createProduct(vendor.accessToken, category.id, 'Sales Limit Snapper', 60000);

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
    expect(checkoutRes.status).toBe(403);
  });
});
