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

interface DriverData {
  id: string;
}

interface DeliveryZoneData {
  id: string;
  code: string;
}

interface FleetAssetData {
  id: string;
  status: string;
  currentDriverId: string | null;
}

interface FleetTripData {
  id: string;
  fleetAssetId: string;
}

interface FleetMaintenanceData {
  id: string;
  status: string;
}

jest.setTimeout(20_000);

describe('Fleet (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zone1: DeliveryZoneData;
  const driverUserEmails: string[] = [];
  const adminEmails: string[] = [];
  const licensePlates: string[] = [];

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
    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zone1 = { id: zone.id, code: zone.code };
  });

  afterAll(async () => {
    if (licensePlates.length > 0) {
      // FleetTrip.fleetAssetId is Restrict; trips must be cleared first.
      // FleetMaintenance.fleetAssetId cascades, so no explicit cleanup needed.
      await prisma.fleetTrip.deleteMany({
        where: { fleetAsset: { licensePlate: { in: licensePlates } } },
      });
      await prisma.fleetAsset.deleteMany({ where: { licensePlate: { in: licensePlates } } });
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
    const email = `fleet-admin-${randomUUID()}@example.com`;
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

  async function createApprovedDriver(adminToken: string, licensePlate: string): Promise<string> {
    const email = `fleet-driver-${randomUUID()}@example.com`;
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

    return driverId;
  }

  async function createFleetAsset(
    adminToken: string,
    licensePlate: string,
  ): Promise<FleetAssetData> {
    licensePlates.push(licensePlate);
    const res = await request(server())
      .post('/api/v1/fleet-assets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        zoneId: zone1.id,
        assetType: 'REFRIGERATED_TRUCK',
        ownership: 'COMPANY_OWNED',
        licensePlate,
        capacityLbs: 2000,
        coldChainCapable: true,
      });
    return data<FleetAssetData>(res);
  }

  it('creates a zone-scoped fleet asset, assigns a driver, and retires it', async () => {
    const adminToken = await createAdminAndLogin();
    const driverId = await createApprovedDriver(adminToken, 'FA 1111');

    const createRes = await request(server())
      .post('/api/v1/fleet-assets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        zoneId: zone1.id,
        assetType: 'TRUCK',
        ownership: 'COMPANY_OWNED',
        licensePlate: 'FA 2222',
        capacityLbs: 1500,
      });
    expect(createRes.status).toBe(201);
    licensePlates.push('FA 2222');
    const asset = data<FleetAssetData>(createRes);
    expect(asset.status).toBe('ACTIVE');
    expect(asset.currentDriverId).toBeNull();

    const getRes = await request(server())
      .get(`/api/v1/fleet-assets/${asset.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);
    expect(data<FleetAssetData>(getRes).id).toBe(asset.id);

    const assignRes = await request(server())
      .patch(`/api/v1/fleet-assets/${asset.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ currentDriverId: driverId });
    expect(assignRes.status).toBe(200);
    expect(data<FleetAssetData>(assignRes).currentDriverId).toBe(driverId);

    const retireRes = await request(server())
      .patch(`/api/v1/fleet-assets/${asset.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RETIRED' });
    expect(retireRes.status).toBe(200);
    expect(data<FleetAssetData>(retireRes).status).toBe('RETIRED');
  });

  it('rejects creating a fleet asset with an unknown zone or a duplicate license plate', async () => {
    const adminToken = await createAdminAndLogin();

    const unknownZoneRes = await request(server())
      .post('/api/v1/fleet-assets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        zoneId: randomUUID(),
        assetType: 'VAN',
        ownership: 'COMPANY_OWNED',
        licensePlate: 'FA 3333',
        capacityLbs: 800,
      });
    expect(unknownZoneRes.status).toBe(404);

    const asset = await createFleetAsset(adminToken, 'FA 4444');

    const duplicateRes = await request(server())
      .post('/api/v1/fleet-assets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        zoneId: zone1.id,
        assetType: 'VAN',
        ownership: 'COMPANY_OWNED',
        licensePlate: 'FA 4444',
        capacityLbs: 800,
      });
    expect(duplicateRes.status).toBe(409);
    expect(asset.status).toBe('ACTIVE');
  });

  it('lists fleet assets filtered by zone and status', async () => {
    const adminToken = await createAdminAndLogin();
    const asset = await createFleetAsset(adminToken, 'FA 5555');

    const listRes = await request(server())
      .get('/api/v1/fleet-assets')
      .query({ zoneId: zone1.id, status: 'ACTIVE' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const list = data<{ items: FleetAssetData[]; total: number }>(listRes);
    expect(list.items.some((item) => item.id === asset.id)).toBe(true);
  });

  it('records a fleet trip for an asset and driver in the same zone', async () => {
    const adminToken = await createAdminAndLogin();
    const driverId = await createApprovedDriver(adminToken, 'FA 6666');
    const asset = await createFleetAsset(adminToken, 'FA 7777');

    const createTripRes = await request(server())
      .post('/api/v1/fleet-trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fleetAssetId: asset.id,
        driverId,
        zoneId: zone1.id,
        startedAt: '2026-07-08T08:00:00.000Z',
        fuelCost: 1500,
      });
    expect(createTripRes.status).toBe(201);
    const trip = data<FleetTripData>(createTripRes);
    expect(trip.fleetAssetId).toBe(asset.id);

    const updateTripRes = await request(server())
      .patch(`/api/v1/fleet-trips/${trip.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ endedAt: '2026-07-08T10:00:00.000Z', driverWage: 2000 });
    expect(updateTripRes.status).toBe(200);

    const listRes = await request(server())
      .get('/api/v1/fleet-trips')
      .query({ fleetAssetId: asset.id })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    const list = data<{ items: FleetTripData[]; total: number }>(listRes);
    expect(list.items.some((item) => item.id === trip.id)).toBe(true);
  });

  it('records a maintenance event and flips the asset to MAINTENANCE, then resolves it', async () => {
    const adminToken = await createAdminAndLogin();
    const asset = await createFleetAsset(adminToken, 'FA 8888');

    const createMaintenanceRes = await request(server())
      .post(`/api/v1/fleet-assets/${asset.id}/maintenance`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ serviceDate: '2026-07-08T00:00:00.000Z', status: 'IN_PROGRESS', technician: 'Joe Mechanic' });
    expect(createMaintenanceRes.status).toBe(201);
    const maintenance = data<FleetMaintenanceData>(createMaintenanceRes);
    expect(maintenance.status).toBe('IN_PROGRESS');

    const assetAfterRes = await request(server())
      .get(`/api/v1/fleet-assets/${asset.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(data<FleetAssetData>(assetAfterRes).status).toBe('MAINTENANCE');

    const listMaintenanceRes = await request(server())
      .get(`/api/v1/fleet-assets/${asset.id}/maintenance`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listMaintenanceRes.status).toBe(200);
    const list = data<{ items: FleetMaintenanceData[]; total: number }>(listMaintenanceRes);
    expect(list.items.some((item) => item.id === maintenance.id)).toBe(true);

    const resolveRes = await request(server())
      .patch(`/api/v1/fleet-maintenance/${maintenance.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'COMPLETED', cost: 5000 });
    expect(resolveRes.status).toBe(200);
    expect(data<FleetMaintenanceData>(resolveRes).status).toBe('COMPLETED');
  });

  it('rejects fleet endpoints for non-admin roles', async () => {
    const driverEmail = `fleet-nonadmin-${randomUUID()}@example.com`;
    driverUserEmails.push(driverEmail);
    await request(server()).post('/api/v1/auth/register').send({
      email: driverEmail,
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Nadia',
      lastName: 'Nonadmin',
      role: 'DRIVER',
    });
    const loginRes = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: driverEmail, password: 'StrongPass1' });
    const driverToken = data<SessionData>(loginRes).accessToken;

    const res = await request(server())
      .post('/api/v1/fleet-assets')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        zoneId: zone1.id,
        assetType: 'TRUCK',
        ownership: 'COMPANY_OWNED',
        licensePlate: 'FA 9999',
        capacityLbs: 1000,
      });
    expect(res.status).toBe(403);
  });
});
