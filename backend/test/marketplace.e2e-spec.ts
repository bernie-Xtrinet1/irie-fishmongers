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
  status: string;
}

interface ProductData {
  id: string;
  isActive: boolean;
  quantityAvailable: number;
  availability: string;
}

interface CategoryData {
  id: string;
  slug: string;
}

// Several tests chain multiple sequential requests, well beyond Jest's
// default 5s per-test timeout once run alongside the rest of the e2e
// suite's parallel workers.
jest.setTimeout(60_000);

describe('Marketplace (e2e)', () => {
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
      await prisma.inventoryEvent.deleteMany({
        where: { product: { vendor: { user: { email: { in: createdEmails } } } } },
      });
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    if (app) {
      await app.close();
    }
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

  function vendorRegistrationPayload(businessName: string): {
    businessName: string;
    parish: 'KINGSTON';
    acceptedTerms: true;
  } {
    return { businessName, parish: 'KINGSTON', acceptedTerms: true };
  }

  async function getFishCategory(): Promise<CategoryData> {
    const res = await request(server()).get('/api/v1/categories');
    const categories = data<CategoryData[]>(res);
    const fish = categories.find((category) => category.slug === 'fish');
    if (!fish) {
      throw new Error('Expected seeded "fish" category to exist');
    }
    return fish;
  }

  it('supports the full vendor approval -> product listing -> search -> stock -> deactivate flow', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerAndLoginVendor();
    const category = await getFishCategory();

    const registerVendorRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send(vendorRegistrationPayload("Vera's Fresh Catch"));
    expect(registerVendorRes.status).toBe(201);
    const vendorProfile = data<VendorData>(registerVendorRes);
    expect(vendorProfile.status).toBe('PENDING');

    const blockedCreateRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'Fresh Snapper',
        description: 'Caught this morning off the north coast.',
        unit: 'PER_POUND',
        price: 850,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/snapper.jpg',
      });
    expect(blockedCreateRes.status).toBe(403);

    const approveRes = await request(server())
      .patch(`/api/v1/vendors/${vendorProfile.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });
    expect(approveRes.status).toBe(200);
    expect(data<VendorData>(approveRes).status).toBe('APPROVED');

    // COMMUNITY_FISHER (the default tier on registration) requires an
    // APPROVED GOVERNMENT_ID before the vendor may list products.
    const uploadRes = await request(server())
      .post('/api/v1/vendor-documents')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ documentType: 'GOVERNMENT_ID', fileUrl: 'https://cdn.example.com/vendor-docs/doc.jpg' });
    await request(server())
      .patch(`/api/v1/vendor-documents/${data<{ id: string }>(uploadRes).id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });

    const createRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'Fresh Snapper',
        description: 'Caught this morning off the north coast.',
        unit: 'PER_POUND',
        price: 850,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/snapper.jpg',
      });
    expect(createRes.status).toBe(201);
    const product = data<ProductData>(createRes);
    expect(product.availability).toBe('ACTIVE');

    const getRes = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(getRes.status).toBe(200);
    expect(data<ProductData>(getRes).id).toBe(product.id);

    const searchRes = await request(server())
      .get('/api/v1/products')
      .query({ search: 'Fresh Snapper', categoryId: category.id });
    expect(searchRes.status).toBe(200);
    const searchBody = data<{ items: ProductData[]; total: number }>(searchRes);
    expect(searchBody.items.map((item) => item.id)).toContain(product.id);

    const stockRes = await request(server())
      .patch(`/api/v1/products/${product.id}/stock`)
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ delta: -10 });
    expect(stockRes.status).toBe(200);
    expect(data<ProductData>(stockRes).availability).toBe('OUT_OF_STOCK');

    const overDrawRes = await request(server())
      .patch(`/api/v1/products/${product.id}/stock`)
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ delta: -1 });
    expect(overDrawRes.status).toBe(409);

    const deactivateRes = await request(server())
      .patch(`/api/v1/products/${product.id}/deactivate`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(deactivateRes.status).toBe(200);

    const hiddenRes = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(hiddenRes.status).toBe(404);

    const reactivateRes = await request(server())
      .patch(`/api/v1/products/${product.id}/reactivate`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(reactivateRes.status).toBe(200);

    const visibleAgainRes = await request(server()).get(`/api/v1/products/${product.id}`);
    expect(visibleAgainRes.status).toBe(200);
  });

  it('rejects a second vendor profile registration for the same account', async () => {
    const vendor = await registerAndLoginVendor();

    await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send(vendorRegistrationPayload('First Business'))
      .expect(201);

    const res = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send(vendorRegistrationPayload('Second Business'));
    expect(res.status).toBe(409);
  });

  it('rejects a non-admin attempting to approve a vendor', async () => {
    const vendor = await registerAndLoginVendor();
    const registerVendorRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send(vendorRegistrationPayload('Some Business'));
    const vendorProfile = data<VendorData>(registerVendorRes);

    const res = await request(server())
      .patch(`/api/v1/vendors/${vendorProfile.id}/status`)
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  it('rejects a vendor editing a product they do not own', async () => {
    const adminToken = await createAdminAndLogin();
    const category = await getFishCategory();

    const ownerVendor = await registerAndLoginVendor();
    const ownerProfileRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${ownerVendor.accessToken}`)
      .send(vendorRegistrationPayload("Owner's Shop"));
    const ownerProfile = data<VendorData>(ownerProfileRes);
    await request(server())
      .patch(`/api/v1/vendors/${ownerProfile.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    // COMMUNITY_FISHER (the default tier on registration) requires an
    // APPROVED GOVERNMENT_ID before the vendor may list products.
    const ownerUploadRes = await request(server())
      .post('/api/v1/vendor-documents')
      .set('Authorization', `Bearer ${ownerVendor.accessToken}`)
      .send({ documentType: 'GOVERNMENT_ID', fileUrl: 'https://cdn.example.com/vendor-docs/doc.jpg' });
    await request(server())
      .patch(`/api/v1/vendor-documents/${data<{ id: string }>(ownerUploadRes).id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });

    const createRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${ownerVendor.accessToken}`)
      .send({
        categoryId: category.id,
        name: 'Owner Product',
        description: 'A product owned by the first vendor.',
        unit: 'PER_ITEM',
        price: 100,
        quantityAvailable: 5,
        imageUrl: 'https://cdn.example.com/owner.jpg',
      });
    const product = data<ProductData>(createRes);

    const otherVendor = await registerAndLoginVendor();
    await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${otherVendor.accessToken}`)
      .send(vendorRegistrationPayload("Other Vendor's Shop"));

    const res = await request(server())
      .patch(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${otherVendor.accessToken}`)
      .send({ name: 'Hijacked Name' });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated product creation attempt', async () => {
    const category = await getFishCategory();
    const res = await request(server())
      .post('/api/v1/products')
      .send({
        categoryId: category.id,
        name: 'No Auth Product',
        description: 'Should not be creatable without a token.',
        unit: 'PER_ITEM',
        price: 100,
        quantityAvailable: 5,
        imageUrl: 'https://cdn.example.com/no-auth.jpg',
      });
    expect(res.status).toBe(401);
  });

  it('rejects creating a product with a non-existent category', async () => {
    const adminToken = await createAdminAndLogin();
    const vendor = await registerAndLoginVendor();
    const profileRes = await request(server())
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send(vendorRegistrationPayload('No Category Shop'));
    const profile = data<VendorData>(profileRes);
    await request(server())
      .patch(`/api/v1/vendors/${profile.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'APPROVED' });

    // COMMUNITY_FISHER (the default tier on registration) requires an
    // APPROVED GOVERNMENT_ID before the vendor may list products.
    const noCategoryUploadRes = await request(server())
      .post('/api/v1/vendor-documents')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({ documentType: 'GOVERNMENT_ID', fileUrl: 'https://cdn.example.com/vendor-docs/doc.jpg' });
    await request(server())
      .patch(`/api/v1/vendor-documents/${data<{ id: string }>(noCategoryUploadRes).id}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED' });

    const res = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendor.accessToken}`)
      .send({
        categoryId: randomUUID(),
        name: 'Ghost Category Product',
        description: 'References a category that does not exist.',
        unit: 'PER_ITEM',
        price: 100,
        quantityAvailable: 5,
        imageUrl: 'https://cdn.example.com/ghost.jpg',
      });
    expect(res.status).toBe(400);
  });
});
