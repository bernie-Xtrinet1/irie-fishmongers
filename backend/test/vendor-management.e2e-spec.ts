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
  businessName: string;
  status: string;
  parish: string;
  phone?: string | null;
}

interface VendorPublicData {
  id: string;
  businessName: string;
  parish: string;
  tier: string;
}

interface PaginatedVendorsData {
  items: VendorData[];
  total: number;
}

interface ProductData {
  id: string;
  isActive: boolean;
}

interface PaginatedProductsData {
  items: ProductData[];
  total: number;
}

// Several tests chain multiple sequential requests, well beyond Jest's
// default 5s per-test timeout once run alongside the rest of the e2e
// suite's parallel workers.
jest.setTimeout(20_000);

describe('Vendor Management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdEmails: string[] = [];

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
    if (createdEmails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await app.close();
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${randomUUID()}@example.com`;
    createdEmails.push(email);
    return email;
  }

  async function createAdminAndLogin(): Promise<string> {
    const email = uniqueEmail('admin');
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

  async function registerAndLoginVendor(): Promise<{ email: string; accessToken: string }> {
    const email = uniqueEmail('vendor');
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

    return { email, accessToken: data<SessionData>(loginRes).accessToken };
  }

  it('rejects vendor registration without accepting terms', async () => {
    const vendor = await registerAndLoginVendor();
    const res = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'No Terms Shop', parish: 'KINGSTON', acceptedTerms: false });
    expect(res.status).toBe(400);
  });

  it('rejects vendor registration with an invalid parish', async () => {
    const vendor = await registerAndLoginVendor();
    const res = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'Bad Parish Shop', parish: 'ATLANTIS', acceptedTerms: true });
    expect(res.status).toBe(400);
  });

  it('allows a vendor to update their own profile', async () => {
    const vendor = await registerAndLoginVendor();
    await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'Original Name', parish: 'KINGSTON', acceptedTerms: true });

    const updateRes = await request(server())
      .patch('/api/v1/vendors/me')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'Updated Name', description: 'A wonderful seafood shop by the sea.' });

    expect(updateRes.status).toBe(200);
    const updated = data<VendorData>(updateRes);
    expect(updated.businessName).toBe('Updated Name');
  });

  it('rejects a non-vendor from registering a vendor profile', async () => {
    const email = uniqueEmail('customer');
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
    const accessToken = data<SessionData>(loginRes).accessToken;

    const res = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ businessName: 'Customer Shop', parish: 'KINGSTON', acceptedTerms: true });
    expect(res.status).toBe(403);
  });

  it('lists vendors for an admin, filtered by status', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerAndLoginVendor();
    const registerRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'Listable Shop', parish: 'ST_ANDREW', acceptedTerms: true });
    const vendorProfile = data<VendorData>(registerRes);

    const listRes = await request(server())
      .get('/api/v1/vendors')
      .query({ status: 'PENDING' })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    const listBody = data<PaginatedVendorsData>(listRes);
    expect(listBody.items.map((item) => item.id)).toContain(vendorProfile.id);
    expect(listBody.items.every((item) => item.status === 'PENDING')).toBe(true);
  });

  it('rejects a non-admin from listing vendors', async () => {
    const vendor = await registerAndLoginVendor();
    const res = await request(server())
      .get('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('exposes a public storefront profile only for approved vendors', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerAndLoginVendor();
    const registerRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'Public Shop', parish: 'ST_MARY', acceptedTerms: true });
    const vendorProfile = data<VendorData>(registerRes);

    const beforeApprovalRes = await request(server()).get(
      `/api/v1/vendors/${vendorProfile.id}/public`,
    );
    expect(beforeApprovalRes.status).toBe(404);

    await request(server())
      .patch(`/api/v1/vendors/${vendorProfile.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    const afterApprovalRes = await request(server()).get(
      `/api/v1/vendors/${vendorProfile.id}/public`,
    );
    expect(afterApprovalRes.status).toBe(200);
    const publicProfile = data<VendorPublicData>(afterApprovalRes);
    expect(publicProfile).toEqual({
      id: vendorProfile.id,
      businessName: 'Public Shop',
      description: null,
      parish: 'ST_MARY',
      logoUrl: null,
      tier: 'COMMUNITY_FISHER',
    });
    expect(publicProfile).not.toHaveProperty('phone');
  });

  it("lists all of the vendor's own products including inactive ones", async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerAndLoginVendor();
    const registerRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ businessName: 'My Products Shop', parish: 'PORTLAND', acceptedTerms: true });
    const vendorProfile = data<VendorData>(registerRes);
    await request(server())
      .patch(`/api/v1/vendors/${vendorProfile.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    const categoriesRes = await request(server()).get('/api/v1/categories');
    const fishCategory = data<{ id: string; slug: string }[]>(categoriesRes).find(
      (category) => category.slug === 'fish',
    )!;

    const createRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: fishCategory.id,
        name: 'Private Listing',
        description: 'A product only visible to its owner once deactivated.',
        unit: 'PER_ITEM',
        price: 500,
        quantityAvailable: 5,
        imageUrl: 'https://cdn.example.com/private.jpg',
      });
    const product = data<ProductData>(createRes);

    await request(server())
      .patch(`/api/v1/products/${product.id}/deactivate`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);

    const publicSearchRes = await request(server())
      .get('/api/v1/products')
      .query({ vendorId: vendorProfile.id });
    expect(
      data<PaginatedProductsData>(publicSearchRes).items.map((item) => item.id),
    ).not.toContain(product.id);

    const mineRes = await request(server())
      .get('/api/v1/products/mine')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(mineRes.status).toBe(200);
    const mineBody = data<PaginatedProductsData>(mineRes);
    expect(mineBody.items.map((item) => item.id)).toContain(product.id);
    expect(mineBody.items.find((item) => item.id === product.id)?.isActive).toBe(false);
  });

  it('rejects an unauthenticated request to list own products', async () => {
    const res = await request(server()).get('/api/v1/products/mine');
    expect(res.status).toBe(401);
  });
});
