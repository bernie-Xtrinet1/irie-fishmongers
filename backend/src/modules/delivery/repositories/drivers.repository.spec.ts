import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { DriversRepository } from './drivers.repository';

describe('DriversRepository', () => {
  let prisma: PrismaService;
  let repository: DriversRepository;
  let usersRepository: UsersRepository;
  let driverRole: Role;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DriversRepository(prisma);
    usersRepository = new UsersRepository(prisma);
    driverRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });

    const user = await usersRepository.create({
      email: `driver-repo-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Dana',
      lastName: 'Driver',
      roleId: driverRole.id,
      emailVerificationTokenHash: 'token-hash',
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000),
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a driver profile in PENDING status', async () => {
    const driver = await repository.create({
      userId,
      licensePlate: 'AB 1234',
      vehicleType: 'MOTORCYCLE',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });
    expect(driver.status).toBe('PENDING');
    expect(driver.userId).toBe(userId);
    expect(driver.vehicleType).toBe('MOTORCYCLE');
    expect(driver.vehicleOwnership).toBe('PERSONAL_VEHICLE');
  });

  it('finds a driver by id and by userId', async () => {
    const byUserId = await repository.findByUserId(userId);
    expect(byUserId).not.toBeNull();

    const byId = await repository.findById(byUserId!.id);
    expect(byId?.userId).toBe(userId);
  });

  it('returns null when no driver profile exists for a user', async () => {
    await expect(repository.findByUserId(randomUUID())).resolves.toBeNull();
  });

  it('updates driver status', async () => {
    const driver = await repository.findByUserId(userId);
    const updated = await repository.updateStatus(driver!.id, 'APPROVED');
    expect(updated.status).toBe('APPROVED');
  });

  describe('findMany', () => {
    it('filters by status and paginates', async () => {
      const { items, total } = await repository.findMany('APPROVED', { skip: 0, take: 20 });
      expect(total).toBeGreaterThanOrEqual(1);
      expect(items.every((item) => item.status === 'APPROVED')).toBe(true);
    });

    it('returns all drivers when no status filter is given', async () => {
      const { items } = await repository.findMany(undefined, { skip: 0, take: 20 });
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
