import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { FleetAssetsRepository } from './fleet-assets.repository';
import { FleetTripsRepository } from './fleet-trips.repository';

describe('FleetTripsRepository', () => {
  let prisma: PrismaService;
  let repository: FleetTripsRepository;
  let fleetAssetsRepository: FleetAssetsRepository;
  let zoneId: string;
  let fleetAssetId: string;
  let driverId: string;
  let driverUserId: string;
  const licensePlate = `TR ${randomUUID().slice(0, 4)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new FleetTripsRepository(prisma);
    fleetAssetsRepository = new FleetAssetsRepository(prisma);

    const zone = await prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'ZONE_1' } });
    zoneId = zone.id;

    const fleetAsset = await fleetAssetsRepository.create({
      zoneId,
      assetType: 'TRUCK',
      ownership: 'COMPANY_OWNED',
      licensePlate,
      capacityLbs: 1500,
    });
    fleetAssetId = fleetAsset.id;

    const usersRepository = new UsersRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const driverRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });
    const driverUser = await usersRepository.create({
      email: `fleet-trips-driver-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Dana',
      lastName: 'Driver',
      roleId: driverRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    driverUserId = driverUser.id;
    const driver = await driversRepository.create({
      userId: driverUserId,
      licensePlate: `DR ${randomUUID().slice(0, 4)}`,
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    await prisma.fleetTrip.deleteMany({ where: { fleetAssetId } });
    await prisma.fleetAsset.deleteMany({ where: { id: fleetAssetId } });
    await prisma.driver.deleteMany({ where: { userId: driverUserId } });
    await prisma.user.delete({ where: { id: driverUserId } });
    await prisma.onModuleDestroy();
  });

  it('creates a fleet trip', async () => {
    const trip = await repository.create({
      fleetAssetId,
      driverId,
      zoneId,
      startedAt: new Date('2026-07-08T08:00:00.000Z'),
      fuelCost: 1500,
    });

    expect(trip.fleetAssetId).toBe(fleetAssetId);
    expect(trip.endedAt).toBeNull();
  });

  it('finds a fleet trip by id', async () => {
    const created = await repository.create({
      fleetAssetId,
      driverId,
      zoneId,
      startedAt: new Date('2026-07-08T09:00:00.000Z'),
    });
    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('updates a fleet trip end time and cost fields', async () => {
    const created = await repository.create({
      fleetAssetId,
      driverId,
      zoneId,
      startedAt: new Date('2026-07-08T10:00:00.000Z'),
    });
    const updated = await repository.update(created.id, {
      endedAt: new Date('2026-07-08T11:00:00.000Z'),
      driverWage: 2000,
    });
    expect(updated.endedAt).not.toBeNull();
    expect(updated.driverWage?.toNumber()).toBe(2000);
  });

  describe('findMany', () => {
    it('filters by fleet asset and driver', async () => {
      const { items, total } = await repository.findMany(
        { fleetAssetId, driverId },
        { skip: 0, take: 20 },
      );
      expect(total).toBeGreaterThanOrEqual(3);
      expect(items.every((item) => item.fleetAssetId === fleetAssetId)).toBe(true);
    });
  });
});
