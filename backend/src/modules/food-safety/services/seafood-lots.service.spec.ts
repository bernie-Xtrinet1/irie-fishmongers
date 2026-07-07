import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName, SeafoodLot, Vendor } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateSeafoodLotDto } from '../dto/create-seafood-lot.dto';
import { LotWithVendor, SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { SeafoodLotsService } from './seafood-lots.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    termsAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLot(overrides: Partial<SeafoodLot> = {}): SeafoodLot {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    vendorId: 'vendor-1',
    species: 'Snapper',
    storageType: 'FRESH',
    catchDate: new Date('2026-01-15'),
    catchLocation: 'North Coast',
    landingSite: 'Falmouth Landing Site',
    weight: { toString: () => '20' } as unknown as SeafoodLot['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: null,
    qualityScore: null,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLotWithVendor(overrides: Partial<LotWithVendor> = {}): LotWithVendor {
  return {
    ...buildLot(),
    vendor: buildVendor(),
    ...overrides,
  };
}

describe('SeafoodLotsService', () => {
  let lotsRepository: jest.Mocked<
    Pick<
      SeafoodLotsRepository,
      | 'create'
      | 'findById'
      | 'findByIdWithVendor'
      | 'updateStatus'
      | 'countCreatedThisYear'
      | 'findManyByVendor'
      | 'findMany'
    >
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let alertsRepository: jest.Mocked<Pick<TemperatureAlertsRepository, 'countUnresolvedByLotId'>>;
  let service: SeafoodLotsService;

  beforeEach(() => {
    lotsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdWithVendor: jest.fn(),
      updateStatus: jest.fn(),
      countCreatedThisYear: jest.fn(),
      findManyByVendor: jest.fn(),
      findMany: jest.fn(),
    };
    vendorsRepository = { findByUserId: jest.fn() };
    alertsRepository = { countUnresolvedByLotId: jest.fn() };

    service = new SeafoodLotsService(
      lotsRepository as unknown as SeafoodLotsRepository,
      vendorsRepository as unknown as VendorsRepository,
      alertsRepository as unknown as TemperatureAlertsRepository,
    );
  });

  describe('register', () => {
    const dto: CreateSeafoodLotDto = {
      species: 'Snapper',
      storageType: 'FRESH',
      catchDate: '2026-01-15',
      catchLocation: 'North Coast',
      landingSite: 'Falmouth Landing Site',
      weight: 20,
      weightUnit: 'POUNDS',
    };

    it('registers a lot for an approved vendor, generating a lot number', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      lotsRepository.countCreatedThisYear.mockResolvedValue(4);
      lotsRepository.create.mockResolvedValue(buildLot({ lotNumber: 'LOT-2026-000005' }));

      const result = await service.register('vendor-user-1', dto);

      expect(result.lotNumber).toBe('LOT-2026-000005');
      expect(lotsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          vendorId: 'vendor-1',
          species: 'Snapper',
          storageType: 'FRESH',
          weight: 20,
          weightUnit: 'POUNDS',
        }),
      );
    });

    it('throws when the user has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.register('vendor-user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the vendor is not approved', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ status: 'PENDING' }));
      await expect(service.register('vendor-user-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('getMine', () => {
    it("returns the vendor's own lots", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      lotsRepository.findManyByVendor.mockResolvedValue({ items: [buildLot()], total: 1 });

      const result = await service.getMine('vendor-user-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]?.id).toBe('lot-1');
      expect(lotsRepository.findManyByVendor).toHaveBeenCalledWith('vendor-1', { skip: 0, take: 20 });
    });

    it('throws when the user has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.getMine('vendor-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('lists lots with filters applied', async () => {
      lotsRepository.findMany.mockResolvedValue({ items: [buildLot()], total: 1 });

      const result = await service.list({
        page: 1,
        pageSize: 20,
        vendorId: 'vendor-1',
        status: 'SAFE',
      });

      expect(result.total).toBe(1);
      expect(lotsRepository.findMany).toHaveBeenCalledWith(
        { vendorId: 'vendor-1', status: 'SAFE' },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('getById', () => {
    it('returns a lot by id', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      const result = await service.getById('lot-1');
      expect(result.id).toBe('lot-1');
    });

    it('throws when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPublicById', () => {
    it('returns the public traceability view with temperatureVerified true when no active alerts', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor());
      alertsRepository.countUnresolvedByLotId.mockResolvedValue(0);

      const result = await service.getPublicById('lot-1');

      expect(result.temperatureVerified).toBe(true);
      expect(result.vendorBusinessName).toBe("Vera's Catch");
    });

    it('returns temperatureVerified false when there are unresolved alerts', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor());
      alertsRepository.countUnresolvedByLotId.mockResolvedValue(2);

      const result = await service.getPublicById('lot-1');
      expect(result.temperatureVerified).toBe(false);
    });

    it('throws when the lot does not exist', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(null);
      await expect(service.getPublicById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates a lot status with a reason', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      lotsRepository.updateStatus.mockResolvedValue(
        buildLot({ foodSafetyStatus: 'QUARANTINED', statusNotes: 'Cleared after review' }),
      );

      const result = await service.updateStatus('lot-1', 'QUARANTINED', 'Cleared after review');

      expect(result.foodSafetyStatus).toBe('QUARANTINED');
      expect(lotsRepository.updateStatus).toHaveBeenCalledWith('lot-1', 'QUARANTINED', 'Cleared after review');
    });

    it('throws when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('missing', 'SAFE')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assertOwnedByRequester', () => {
    const adminUser: RequestUser = {
      id: 'admin-1',
      email: 'admin@example.com',
      roles: [RoleName.ADMINISTRATOR],
    };
    const vendorUser: RequestUser = {
      id: 'vendor-user-1',
      email: 'vendor@example.com',
      roles: [RoleName.VENDOR],
    };

    it('bypasses ownership checks entirely for an admin', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor({ vendorId: 'someone-elses-vendor' }));

      const result = await service.assertOwnedByRequester(adminUser, 'lot-1');

      expect(result.id).toBe('lot-1');
      expect(vendorsRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('allows a vendor who owns the lot', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor({ vendorId: 'vendor-1' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-1' }));

      const result = await service.assertOwnedByRequester(vendorUser, 'lot-1');
      expect(result.id).toBe('lot-1');
    });

    it('throws ForbiddenException when the vendor does not own the lot', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor({ vendorId: 'vendor-1' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-2' }));

      await expect(service.assertOwnedByRequester(vendorUser, 'lot-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when the requester has no vendor profile', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(buildLotWithVendor({ vendorId: 'vendor-1' }));
      vendorsRepository.findByUserId.mockResolvedValue(null);

      await expect(service.assertOwnedByRequester(vendorUser, 'lot-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when the lot does not exist', async () => {
      lotsRepository.findByIdWithVendor.mockResolvedValue(null);
      await expect(service.assertOwnedByRequester(vendorUser, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
