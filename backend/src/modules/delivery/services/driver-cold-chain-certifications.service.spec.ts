import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Driver, DriverColdChainCertification } from '@prisma/client';

import { DriversRepository } from '../repositories/drivers.repository';
import { DriverColdChainCertificationsRepository } from '../repositories/driver-cold-chain-certifications.repository';
import { DriverColdChainCertificationsService } from './driver-cold-chain-certifications.service';

function buildDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'driver-1',
    userId: 'driver-user-1',
    licensePlate: 'AB 1234',
    vehicleType: 'CAR',
    vehicleOwnership: 'PERSONAL_VEHICLE',
    status: 'APPROVED',
    availabilityStatus: 'ONLINE',
    capacityLbs: null,
    coldChainCapable: false,
    assignedZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCertification(
  overrides: Partial<DriverColdChainCertification> = {},
): DriverColdChainCertification {
  return {
    id: 'cert-1',
    driverId: 'driver-1',
    issuedBy: 'HACCP Cold Chain Handler',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    status: 'ACTIVE',
    documentUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DriverColdChainCertificationsService', () => {
  let certificationsRepository: jest.Mocked<
    Pick<
      DriverColdChainCertificationsRepository,
      'create' | 'findById' | 'revoke' | 'findByDriverId' | 'findActiveByDriverId'
    >
  >;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findById'>>;
  let service: DriverColdChainCertificationsService;

  beforeEach(() => {
    certificationsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      revoke: jest.fn(),
      findByDriverId: jest.fn(),
      findActiveByDriverId: jest.fn(),
    };
    driversRepository = { findById: jest.fn() };
    service = new DriverColdChainCertificationsService(
      certificationsRepository as unknown as DriverColdChainCertificationsRepository,
      driversRepository as unknown as DriversRepository,
    );
  });

  describe('create', () => {
    const dto = {
      issuedBy: 'HACCP Cold Chain Handler',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    };

    it('issues a certification for an existing driver', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      certificationsRepository.create.mockResolvedValue(buildCertification());

      const result = await service.create('driver-1', dto);
      expect(result.id).toBe('cert-1');
    });

    it('throws when the driver does not exist', async () => {
      driversRepository.findById.mockResolvedValue(null);
      await expect(service.create('missing', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(certificationsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an expiresAt that is not after issuedAt', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      await expect(
        service.create('driver-1', { ...dto, expiresAt: dto.issuedAt }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(certificationsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('findByDriverId', () => {
    it('paginates a driver’s certifications', async () => {
      driversRepository.findById.mockResolvedValue(buildDriver());
      certificationsRepository.findByDriverId.mockResolvedValue({
        items: [buildCertification()],
        total: 1,
      });

      const result = await service.findByDriverId('driver-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('throws when the driver does not exist', async () => {
      driversRepository.findById.mockResolvedValue(null);
      await expect(
        service.findByDriverId('missing', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revoke', () => {
    it('revokes an active certification', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification());
      certificationsRepository.revoke.mockResolvedValue(
        buildCertification({ status: 'REVOKED' }),
      );

      const result = await service.revoke('cert-1');
      expect(result.status).toBe('REVOKED');
    });

    it('rejects revoking an already-revoked certification', async () => {
      certificationsRepository.findById.mockResolvedValue(
        buildCertification({ status: 'REVOKED' }),
      );
      await expect(service.revoke('cert-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the certification does not exist', async () => {
      certificationsRepository.findById.mockResolvedValue(null);
      await expect(service.revoke('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('computeIsCertified', () => {
    it('is true when at least one active, non-expired certification exists', async () => {
      certificationsRepository.findActiveByDriverId.mockResolvedValue([buildCertification()]);
      await expect(service.computeIsCertified('driver-1')).resolves.toBe(true);
    });

    it('is false when no active certification exists', async () => {
      certificationsRepository.findActiveByDriverId.mockResolvedValue([]);
      await expect(service.computeIsCertified('driver-1')).resolves.toBe(false);
    });
  });
});
