import { randomUUID } from 'crypto';

import { RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { DriverLocationsRepository } from './driver-locations.repository';
import { DriversRepository } from './drivers.repository';

describe('DriverLocationsRepository', () => {
  let prisma: PrismaService;
  let repository: DriverLocationsRepository;
  let driverId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DriverLocationsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const driverRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });

    const user = await usersRepository.create({
      email: `driver-location-repo-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Dana',
      lastName: 'Driver',
      roleId: driverRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;

    const driver = await driversRepository.create({
      userId,
      licensePlate: 'CD 5678',
      vehicleType: 'CAR',
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('returns null when a driver has no recorded location', async () => {
    await expect(repository.findLatestByDriverId(randomUUID())).resolves.toBeNull();
  });

  it('records a location reading', async () => {
    const location = await repository.record(driverId, 17.9714, -76.7931);
    expect(location.driverId).toBe(driverId);
    expect(location.latitude).toBeCloseTo(17.9714);
    expect(location.longitude).toBeCloseTo(-76.7931);
  });

  it('returns the most recently recorded location for a driver', async () => {
    await repository.record(driverId, 18.0, -76.8);
    const latest = await repository.findLatestByDriverId(driverId);
    expect(latest?.latitude).toBeCloseTo(18.0);
    expect(latest?.longitude).toBeCloseTo(-76.8);
  });
});
