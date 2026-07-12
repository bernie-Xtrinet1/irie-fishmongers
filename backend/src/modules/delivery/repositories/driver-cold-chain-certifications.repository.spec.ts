import { randomUUID } from 'crypto';

import { Role, RoleName } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UsersRepository } from '../../auth/repositories/users.repository';
import { DriversRepository } from './drivers.repository';
import { DriverColdChainCertificationsRepository } from './driver-cold-chain-certifications.repository';

describe('DriverColdChainCertificationsRepository', () => {
  let prisma: PrismaService;
  let repository: DriverColdChainCertificationsRepository;
  let driverId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    repository = new DriverColdChainCertificationsRepository(prisma);

    const usersRepository = new UsersRepository(prisma);
    const driversRepository = new DriversRepository(prisma);
    const driverRole: Role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.DRIVER } });

    const user = await usersRepository.create({
      email: `driver-cert-${randomUUID()}@example.com`,
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
      licensePlate: `CC ${randomUUID().slice(0, 4)}`,
      vehicleType: 'CAR',
      vehicleOwnership: 'PERSONAL_VEHICLE',
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    await prisma.driverColdChainCertification.deleteMany({ where: { driverId } });
    await prisma.driver.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.onModuleDestroy();
  });

  it('creates a certification in ACTIVE status', async () => {
    const cert = await repository.create({
      driverId,
      issuedBy: 'HACCP Cold Chain Handler',
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });

    expect(cert.status).toBe('ACTIVE');
    expect(cert.driverId).toBe(driverId);
  });

  it('finds a certification by id', async () => {
    const created = await repository.create({
      driverId,
      issuedBy: 'HACCP Cold Chain Handler',
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    const found = await repository.findById(created.id);
    expect(found?.id).toBe(created.id);
  });

  it('revokes a certification', async () => {
    const created = await repository.create({
      driverId,
      issuedBy: 'HACCP Cold Chain Handler',
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    const revoked = await repository.revoke(created.id);
    expect(revoked.status).toBe('REVOKED');
  });

  it('finds all certifications for a driver', async () => {
    const { items, total } = await repository.findByDriverId(driverId, { skip: 0, take: 20 });
    expect(total).toBeGreaterThanOrEqual(3);
    expect(items.every((item) => item.driverId === driverId)).toBe(true);
  });

  describe('findActiveByDriverId', () => {
    it('excludes revoked and expired certifications, includes active non-expired ones', async () => {
      const now = new Date('2026-06-01T00:00:00.000Z');

      await repository.create({
        driverId,
        issuedBy: 'Expired Cert Issuer',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
      });

      const active = await repository.findActiveByDriverId(driverId, now);

      expect(active.length).toBeGreaterThanOrEqual(2);
      expect(active.every((cert) => cert.status !== 'REVOKED' && cert.expiresAt > now)).toBe(true);
    });
  });
});
