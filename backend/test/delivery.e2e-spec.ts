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

interface FullDeliveryData extends DeliveryData {
  scheduledPickupWindowStart: string | null;
  scheduledPickupWindowEnd: string | null;
  customerDeliveryWindowStart: string | null;
  customerDeliveryWindowEnd: string | null;
  vendorConfirmedAt: string | null;
  customerAcceptanceStatus: string;
  exceptions: { id: string; resolved: boolean }[];
  routeHistory: { distanceKm: string; durationMinutes: number } | null;
}

interface LotData {
  id: string;
}

interface IncidentData {
  id: string;
  lotId: string;
  reportedById: string;
}

interface DeliveryZoneData {
  id: string;
  code: string;
}

interface RoutePlanData {
  strategyName: string;
  orderedStops: { deliveryId: string; vendorOrderId: string }[];
  deliveryRunId: string;
}

interface PerformanceMetricsData {
  onTimeDeliveryRate: number | null;
  failedDeliveryRate: number | null;
  averageDeliveryDurationMinutes: number | null;
}

interface PickupQueueEntryData {
  vendorOrderId: string;
  driverName: string | null;
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
    // Cold-chain rejection tests raise a FoodSafetyIncident with
    // reportedById = the customer; that FK is Restrict, so it must be
    // cleared before the customer user rows are deleted.
    if (customerEmails.length > 0) {
      await prisma.foodSafetyIncident.deleteMany({
        where: { reportedBy: { email: { in: customerEmails } } },
      });
    }
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
      // Frees Product -> SeafoodLot's Restrict constraint, then SeafoodLot ->
      // Vendor's, for the cold-chain products created in this file.
      await prisma.product.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
      await prisma.seafoodLot.deleteMany({ where: { vendor: { user: { email: { in: vendorUserEmails } } } } });
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

    await request(server())
      .patch('/api/v1/drivers/me/availability')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'ONLINE' })
      .expect(200);

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

  async function createColdChainProduct(
    vendorAccessToken: string,
    categoryId: string,
    name: string,
  ): Promise<ProductData & { lotId: string }> {
    const lotRes = await request(server())
      .post('/api/v1/seafood-lots')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        species: 'Yellowfin Snapper',
        storageType: 'FROZEN',
        catchDate: '2026-07-01',
        weight: 20,
        weightUnit: 'POUNDS',
      });
    const lotId = data<LotData>(lotRes).id;

    const productRes = await request(server())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${vendorAccessToken}`)
      .send({
        categoryId,
        lotId,
        name,
        description: 'A cold-chain product created for Delivery e2e tests.',
        unit: 'PER_POUND',
        price: 500,
        quantityAvailable: 10,
        imageUrl: 'https://cdn.example.com/product.jpg',
      });
    return { ...data<ProductData>(productRes), lotId };
  }

  async function createReadyVendorOrderForProduct(
    customerToken: string,
    vendorAccessToken: string,
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

  it('prevents a driver from claiming a second delivery while busy with one already', async () => {
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
    // The BUSY availability gate (set automatically on the first claim) now
    // rejects before the active-delivery-count check is ever reached.
    expect(secondAssignRes.status).toBe(403);
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

  it('blocks a non-cold-chain driver from claiming a lot-linked delivery and allows a capable one', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Cold Chain Vendor');
    const incapableDriver = await createApprovedDriverAndLogin(adminToken, 'CC 1111');
    const capableDriver = await createApprovedDriverAndLogin(adminToken, 'CC 2222');

    const category = await getFishCategory();
    const product = await createColdChainProduct(vendor.accessToken, category.id, 'Frozen Snapper');
    const { vendorOrderId } = await createReadyVendorOrderForProduct(
      customerToken,
      vendor.accessToken,
      product.id,
    );

    const rejectedRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${incapableDriver.accessToken}`)
      .send({ vendorOrderId });
    expect(rejectedRes.status).toBe(403);

    await request(server())
      .patch('/api/v1/drivers/me/profile')
      .set('Authorization', `Bearer ${capableDriver.accessToken}`)
      .send({ coldChainCapable: true })
      .expect(200);

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${capableDriver.accessToken}`)
      .send({ vendorOrderId });
    expect(assignRes.status).toBe(201);
  });

  it('sets pickup/delivery scheduling windows and rejects an inverted window', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Schedule Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'SC 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Schedule Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    const invalidRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/schedule`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        scheduledPickupWindowStart: '2026-07-10T12:00:00.000Z',
        scheduledPickupWindowEnd: '2026-07-10T11:00:00.000Z',
      });
    expect(invalidRes.status).toBe(400);

    const validRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/schedule`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({
        scheduledPickupWindowStart: '2026-07-10T09:00:00.000Z',
        scheduledPickupWindowEnd: '2026-07-10T10:00:00.000Z',
        customerDeliveryWindowStart: '2026-07-10T11:00:00.000Z',
        customerDeliveryWindowEnd: '2026-07-10T13:00:00.000Z',
      });
    expect(validRes.status).toBe(200);
    const scheduled = data<FullDeliveryData>(validRes);
    expect(scheduled.scheduledPickupWindowStart).not.toBeNull();
    expect(scheduled.customerDeliveryWindowEnd).not.toBeNull();
  });

  it('records vendor pickup confirmation as an audit fact that does not block the driver picking up', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Vendor Confirm Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'VC 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Vendor Confirm Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    const confirmRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/vendor-confirm`)
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(confirmRes.status).toBe(200);
    expect(data<FullDeliveryData>(confirmRes).vendorConfirmedAt).not.toBeNull();

    const pickedUpRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'PICKED_UP' });
    expect(pickedUpRes.status).toBe(200);
  });

  it('lets a customer accept a delivered order', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Accept Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'AC 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Accept Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'PICKED_UP' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'DELIVERED', proofType: 'PHOTO', proofUrl: 'https://cdn.example.com/proof/a.jpg' })
      .expect(200);

    const acceptRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/customer-acceptance`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ decision: 'ACCEPTED' });
    expect(acceptRes.status).toBe(200);
    const accepted = data<FullDeliveryData>(acceptRes);
    expect(accepted.customerAcceptanceStatus).toBe('ACCEPTED');
    expect(accepted.routeHistory).not.toBeNull();
    expect(Number(accepted.routeHistory?.durationMinutes)).toBeGreaterThanOrEqual(0);
  });

  it('lets a customer reject a delivered order, raising a food safety incident for the linked lot', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Reject Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'RJ 1111');
    const category = await getFishCategory();

    const product = await createColdChainProduct(vendor.accessToken, category.id, 'Reject Snapper');
    await request(server())
      .patch('/api/v1/drivers/me/profile')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ coldChainCapable: true })
      .expect(200);
    const { vendorOrderId } = await createReadyVendorOrderForProduct(
      customerToken,
      vendor.accessToken,
      product.id,
    );

    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'PICKED_UP' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'DELIVERED', proofType: 'PHOTO', proofUrl: 'https://cdn.example.com/proof/b.jpg' })
      .expect(200);

    const rejectRes = await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/customer-acceptance`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ decision: 'REJECTED', reason: 'Package arrived warm and the seal was broken' });
    expect(rejectRes.status).toBe(200);
    expect(data<FullDeliveryData>(rejectRes).customerAcceptanceStatus).toBe('REJECTED');

    // FoodSafetyEventsListener consumes DeliveryRejectedEvent asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const incidentsRes = await request(server())
      .get(`/api/v1/food-safety-incidents/lot/${product.lotId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(incidentsRes.status).toBe(200);
    const incidents = data<{ items: IncidentData[] }>(incidentsRes);
    expect(incidents.items.some((incident) => incident.lotId === product.lotId)).toBe(true);
  });

  it('reports and resolves a delivery exception', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Exception Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'EX 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Exception Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    const createRes = await request(server())
      .post(`/api/v1/delivery/${delivery.id}/exceptions`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ type: 'CUSTOMER_UNAVAILABLE', reason: 'Customer did not answer after three attempts' });
    expect(createRes.status).toBe(201);
    const exception = data<{ id: string; resolved: boolean }>(createRes);
    expect(exception.resolved).toBe(false);

    const resolveRes = await request(server())
      .patch(`/api/v1/delivery/exceptions/${exception.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resolveRes.status).toBe(200);
    expect(data<{ resolved: boolean }>(resolveRes).resolved).toBe(true);
  });

  it('lists delivery zones and resolves the zone for a parish', async () => {
    const customerToken = await createCustomerAndLogin();

    const listRes = await request(server())
      .get('/api/v1/delivery-zones')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(listRes.status).toBe(200);
    const zones = data<DeliveryZoneData[]>(listRes);
    expect(zones.some((zone) => zone.code === 'ZONE_1')).toBe(true);

    const resolveRes = await request(server())
      .get('/api/v1/delivery-zones/resolve')
      .query({ parish: 'KINGSTON' })
      .set('Authorization', `Bearer ${customerToken}`);
    expect(resolveRes.status).toBe(200);
    expect(data<{ zoneId: string | null }>(resolveRes).zoneId).not.toBeNull();
  });

  it('plans and persists a route optimization run for a zone', async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Route Optimization Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'RO 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Route Optimization Snapper',
    );
    await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId })
      .expect(201);

    const zonesRes = await request(server())
      .get('/api/v1/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`);
    const zone1 = data<DeliveryZoneData[]>(zonesRes).find((zone) => zone.code === 'ZONE_1')!;

    const optimizeRes = await request(server())
      .post(`/api/v1/delivery/zones/${zone1.id}/optimize-route`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(optimizeRes.status).toBe(201);
    const plan = data<RoutePlanData>(optimizeRes);
    expect(plan.orderedStops.some((stop) => stop.vendorOrderId === vendorOrderId)).toBe(true);
    expect(plan.deliveryRunId).toBeTruthy();
  });

  it("returns sane driver performance metrics after a completed delivery", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Performance Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'PM 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Performance Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'PICKED_UP' })
      .expect(200);
    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/status`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ action: 'DELIVERED', proofType: 'PHOTO', proofUrl: 'https://cdn.example.com/proof/c.jpg' })
      .expect(200);

    const ownMetricsRes = await request(server())
      .get('/api/v1/drivers/me/performance')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(ownMetricsRes.status).toBe(200);
    const ownMetrics = data<PerformanceMetricsData>(ownMetricsRes);
    expect(ownMetrics.failedDeliveryRate).toBe(0);
    expect(ownMetrics.averageDeliveryDurationMinutes).not.toBeNull();

    const adminMetricsRes = await request(server())
      .get(`/api/v1/drivers/${driver.driverId}/performance`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminMetricsRes.status).toBe(200);
  });

  it("reflects an assigned driver and schedule in the vendor's pickup queue", async () => {
    const adminToken = await createAdminAndLogin();
    const customerToken = await createCustomerAndLogin();
    const vendor = await createApprovedVendorAndLogin(adminToken, 'Pickup Queue Vendor');
    const driver = await createApprovedDriverAndLogin(adminToken, 'PQ 1111');
    const category = await getFishCategory();

    const { vendorOrderId } = await createReadyVendorOrder(
      customerToken,
      vendor.accessToken,
      category.id,
      'Pickup Queue Snapper',
    );
    const assignRes = await request(server())
      .post('/api/v1/delivery/assign')
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ vendorOrderId });
    const delivery = data<DeliveryData>(assignRes);

    await request(server())
      .patch(`/api/v1/delivery/${delivery.id}/schedule`)
      .set('Authorization', `Bearer ${driver.accessToken}`)
      .send({ scheduledPickupWindowStart: '2026-07-10T09:00:00.000Z' })
      .expect(200);

    const queueRes = await request(server())
      .get('/api/v1/vendors/me/pickup-queue')
      .set('Authorization', `Bearer ${vendor.accessToken}`);
    expect(queueRes.status).toBe(200);
    const queue = data<PickupQueueEntryData[]>(queueRes);
    const entry = queue.find((item) => item.vendorOrderId === vendorOrderId);
    expect(entry?.driverName).toBe('Dana Driver');
  });
});
