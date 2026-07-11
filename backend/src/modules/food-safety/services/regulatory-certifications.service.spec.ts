import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Fisherman, LandingSite, RegulatoryAuthority, RegulatoryCertification, Vendor } from '@prisma/client';

import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateRegulatoryCertificationDto } from '../dto/create-regulatory-certification.dto';
import { RegulatoryAuthoritiesRepository } from '../repositories/regulatory-authorities.repository';
import { RegulatoryCertificationsRepository } from '../repositories/regulatory-certifications.repository';
import { RegulatoryCertificationsService } from './regulatory-certifications.service';

function buildAuthority(overrides: Partial<RegulatoryAuthority> = {}): RegulatoryAuthority {
  return {
    id: 'authority-1',
    name: 'Ministry of Health',
    country: 'Jamaica',
    contactEmail: null,
    contactPhone: null,
    website: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCertification(overrides: Partial<RegulatoryCertification> = {}): RegulatoryCertification {
  return {
    id: 'cert-1',
    vendorId: 'vendor-1',
    fishermanId: null,
    landingSiteId: null,
    certificateType: 'Food Handler Permit',
    certificateNumber: 'FHP-2026-004821',
    issuingAuthorityId: 'authority-1',
    issuedDate: new Date('2026-01-15'),
    expiryDate: new Date('2027-01-15'),
    status: 'PENDING',
    documentUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('RegulatoryCertificationsService', () => {
  let certificationsRepository: jest.Mocked<
    Pick<RegulatoryCertificationsRepository, 'create' | 'findById' | 'update' | 'findMany' | 'findActiveButExpired'>
  >;
  let authoritiesRepository: jest.Mocked<Pick<RegulatoryAuthoritiesRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById'>>;
  let fishermenRepository: jest.Mocked<Pick<FishermenRepository, 'findById'>>;
  let landingSitesRepository: jest.Mocked<Pick<LandingSitesRepository, 'findById'>>;
  let service: RegulatoryCertificationsService;

  beforeEach(() => {
    certificationsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      findActiveButExpired: jest.fn(),
    };
    authoritiesRepository = { findById: jest.fn() };
    vendorsRepository = { findById: jest.fn() };
    fishermenRepository = { findById: jest.fn() };
    landingSitesRepository = { findById: jest.fn() };

    service = new RegulatoryCertificationsService(
      certificationsRepository as unknown as RegulatoryCertificationsRepository,
      authoritiesRepository as unknown as RegulatoryAuthoritiesRepository,
      vendorsRepository as unknown as VendorsRepository,
      fishermenRepository as unknown as FishermenRepository,
      landingSitesRepository as unknown as LandingSitesRepository,
    );
  });

  describe('create', () => {
    const dto: CreateRegulatoryCertificationDto = {
      vendorId: 'vendor-1',
      certificateType: 'Food Handler Permit',
      certificateNumber: 'FHP-2026-004821',
      issuingAuthorityId: 'authority-1',
      issuedDate: '2026-01-15',
    };

    it('rejects when no subject is set', async () => {
      await expect(
        service.create({ ...dto, vendorId: undefined }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when more than one subject is set', async () => {
      await expect(
        service.create({ ...dto, fishermanId: 'fisherman-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the issuing authority does not exist', async () => {
      authoritiesRepository.findById.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the vendor subject does not exist', async () => {
      authoritiesRepository.findById.mockResolvedValue(buildAuthority());
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a PENDING certification for a valid vendor subject', async () => {
      authoritiesRepository.findById.mockResolvedValue(buildAuthority());
      vendorsRepository.findById.mockResolvedValue({ id: 'vendor-1' } as Vendor);
      certificationsRepository.create.mockResolvedValue(buildCertification());

      const result = await service.create(dto);

      expect(result.status).toBe('PENDING');
      expect(certificationsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ vendorId: 'vendor-1', issuingAuthorityId: 'authority-1' }),
      );
    });

    it('creates a certification for a valid fisherman subject', async () => {
      authoritiesRepository.findById.mockResolvedValue(buildAuthority());
      fishermenRepository.findById.mockResolvedValue({ id: 'fisherman-1' } as Fisherman);
      certificationsRepository.create.mockResolvedValue(
        buildCertification({ vendorId: null, fishermanId: 'fisherman-1' }),
      );

      const result = await service.create({ ...dto, vendorId: undefined, fishermanId: 'fisherman-1' });

      expect(result.fishermanId).toBe('fisherman-1');
    });

    it('creates a certification for a valid landing site subject', async () => {
      authoritiesRepository.findById.mockResolvedValue(buildAuthority());
      landingSitesRepository.findById.mockResolvedValue({ id: 'site-1' } as LandingSite);
      certificationsRepository.create.mockResolvedValue(
        buildCertification({ vendorId: null, landingSiteId: 'site-1' }),
      );

      const result = await service.create({ ...dto, vendorId: undefined, landingSiteId: 'site-1' });

      expect(result.landingSiteId).toBe('site-1');
    });
  });

  describe('activate', () => {
    it('throws when the certification does not exist', async () => {
      certificationsRepository.findById.mockResolvedValue(null);
      await expect(service.activate('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects activating a non-PENDING certification', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'ACTIVE' }));
      await expect(service.activate('cert-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('moves a PENDING certification to ACTIVE', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'PENDING' }));
      certificationsRepository.update.mockResolvedValue(buildCertification({ status: 'ACTIVE' }));

      const result = await service.activate('cert-1');

      expect(result.status).toBe('ACTIVE');
      expect(certificationsRepository.update).toHaveBeenCalledWith('cert-1', { status: 'ACTIVE' });
    });
  });

  describe('update', () => {
    it('throws when the certification does not exist', async () => {
      certificationsRepository.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a disallowed transition', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'REVOKED' }));
      await expect(service.update('cert-1', { status: 'ACTIVE' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects renewing an EXPIRED certification without a new expiryDate', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'EXPIRED' }));
      await expect(service.update('cert-1', { status: 'ACTIVE' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects renewing an EXPIRED certification with a past expiryDate', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'EXPIRED' }));
      await expect(
        service.update('cert-1', { status: 'ACTIVE', expiryDate: '2020-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('renews an EXPIRED certification with a valid future expiryDate', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'EXPIRED' }));
      certificationsRepository.update.mockResolvedValue(
        buildCertification({ status: 'ACTIVE', expiryDate: new Date('2099-01-01') }),
      );

      const result = await service.update('cert-1', { status: 'ACTIVE', expiryDate: '2099-01-01' });

      expect(result.status).toBe('ACTIVE');
      expect(certificationsRepository.update).toHaveBeenCalledWith('cert-1', {
        status: 'ACTIVE',
        expiryDate: new Date('2099-01-01'),
        documentUrl: undefined,
      });
    });

    it('suspends an ACTIVE certification', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'ACTIVE' }));
      certificationsRepository.update.mockResolvedValue(buildCertification({ status: 'SUSPENDED' }));

      const result = await service.update('cert-1', { status: 'SUSPENDED' });

      expect(result.status).toBe('SUSPENDED');
    });

    it('allows a status-less update (e.g. documentUrl only)', async () => {
      certificationsRepository.findById.mockResolvedValue(buildCertification({ status: 'ACTIVE' }));
      certificationsRepository.update.mockResolvedValue(buildCertification({ status: 'ACTIVE' }));

      await service.update('cert-1', { documentUrl: 'https://cdn.example.com/cert.pdf' });

      expect(certificationsRepository.update).toHaveBeenCalledWith('cert-1', {
        status: undefined,
        expiryDate: undefined,
        documentUrl: 'https://cdn.example.com/cert.pdf',
      });
    });
  });

  describe('list', () => {
    it('sweeps lapsed ACTIVE certifications to EXPIRED before listing', async () => {
      certificationsRepository.findActiveButExpired.mockResolvedValue([buildCertification({ status: 'ACTIVE' })]);
      certificationsRepository.update.mockResolvedValue(buildCertification({ status: 'EXPIRED' }));
      certificationsRepository.findMany.mockResolvedValue({ items: [buildCertification()], total: 1 });

      const result = await service.list({ page: 1, pageSize: 20 });

      expect(certificationsRepository.update).toHaveBeenCalledWith('cert-1', { status: 'EXPIRED' });
      expect(result.total).toBe(1);
    });
  });
});
