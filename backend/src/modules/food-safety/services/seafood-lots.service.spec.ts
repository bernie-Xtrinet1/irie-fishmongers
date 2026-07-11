import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Catch, RoleName, SeafoodLot, Species, Vendor } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CatchItemWithCatch, CatchItemsRepository } from '../../catches/repositories/catch-items.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { SpeciesRepository } from '../../catches/repositories/species.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateSeafoodLotDto } from '../dto/create-seafood-lot.dto';
import { LotWithVendor, SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
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
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLot(overrides: Partial<SeafoodLot> = {}): SeafoodLot {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
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

function buildSpecies(overrides: Partial<Species> = {}): Species {
  return {
    id: 'species-1',
    scientificName: 'Lutjanus analis',
    commercialName: 'Snapper',
    regulatoryStatus: 'UNRESTRICTED',
    seasonalStartMonth: null,
    seasonalEndMonth: null,
    minimumSizeCm: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCatch(overrides: Partial<Catch> = {}): Catch {
  return {
    id: 'catch-1',
    catchNumber: 'CATCH-2026-000001',
    fishermanId: 'fisherman-1',
    vesselId: null,
    landingSiteId: 'site-1',
    catchDate: new Date('2026-01-15'),
    latitude: null,
    longitude: null,
    fishingArea: 'North Coast',
    photos: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function buildCatchItem(overrides: Partial<CatchItemWithCatch> = {}): CatchItemWithCatch {
  const { catch: catchOverrides, ...itemOverrides } = overrides;
  return {
    id: 'catch-item-1',
    catchId: 'catch-1',
    speciesId: 'species-1',
    weight: { toNumber: () => 15 } as unknown as CatchItemWithCatch['weight'],
    weightUnit: 'POUNDS',
    estimatedFreshness: null,
    createdAt: new Date(),
    catch: buildCatch(catchOverrides),
    ...itemOverrides,
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
  let catchItemsRepository: jest.Mocked<Pick<CatchItemsRepository, 'findById'>>;
  let speciesRepository: jest.Mocked<Pick<SpeciesRepository, 'findById'>>;
  let landingSitesRepository: jest.Mocked<Pick<LandingSitesRepository, 'findById'>>;
  let auditLogService: jest.Mocked<Pick<ComplianceAuditLogService, 'record'>>;
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
    catchItemsRepository = { findById: jest.fn() };
    speciesRepository = { findById: jest.fn() };
    landingSitesRepository = { findById: jest.fn() };
    auditLogService = { record: jest.fn() };

    service = new SeafoodLotsService(
      lotsRepository as unknown as SeafoodLotsRepository,
      vendorsRepository as unknown as VendorsRepository,
      alertsRepository as unknown as TemperatureAlertsRepository,
      catchItemsRepository as unknown as CatchItemsRepository,
      speciesRepository as unknown as SpeciesRepository,
      landingSitesRepository as unknown as LandingSitesRepository,
      auditLogService as unknown as ComplianceAuditLogService,
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

    it('rejects when no catchItemId/speciesId and a legacy-path field is missing', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      const incomplete: CreateSeafoodLotDto = { storageType: 'FRESH' };
      await expect(service.register('vendor-user-1', incomplete)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(lotsRepository.create).not.toHaveBeenCalled();
    });

    describe('with a catchItemId', () => {
      const catchItemDto: CreateSeafoodLotDto = { catchItemId: 'catch-item-1', storageType: 'FRESH' };

      it('derives species/catchDate/weight/weightUnit/landingSite from the linked catch item', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        catchItemsRepository.findById.mockResolvedValue(buildCatchItem());
        speciesRepository.findById.mockResolvedValue(buildSpecies());
        landingSitesRepository.findById.mockResolvedValue({
          id: 'site-1',
          name: 'Falmouth Landing Site',
          parish: 'TRELAWNY',
          latitude: null,
          longitude: null,
          status: 'ACTIVE',
          inspectionStatus: 'NOT_INSPECTED',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        lotsRepository.countCreatedThisYear.mockResolvedValue(0);
        lotsRepository.create.mockResolvedValue(buildLot());

        await service.register('vendor-user-1', catchItemDto);

        expect(lotsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            catchItemId: 'catch-item-1',
            speciesId: 'species-1',
            species: 'Snapper',
            weight: 15,
            weightUnit: 'POUNDS',
            landingSite: 'Falmouth Landing Site',
          }),
        );
      });

      it('throws when the catch item does not exist', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        catchItemsRepository.findById.mockResolvedValue(null);
        await expect(service.register('vendor-user-1', catchItemDto)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });

    describe('with a speciesId only', () => {
      const speciesDto: CreateSeafoodLotDto = {
        speciesId: 'species-1',
        storageType: 'FRESH',
        catchDate: '2026-01-15',
        weight: 20,
        weightUnit: 'POUNDS',
      };

      it('validates and auto-populates the species free-text field', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        speciesRepository.findById.mockResolvedValue(buildSpecies());
        lotsRepository.countCreatedThisYear.mockResolvedValue(0);
        lotsRepository.create.mockResolvedValue(buildLot());

        await service.register('vendor-user-1', speciesDto);

        expect(lotsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ speciesId: 'species-1', species: 'Snapper' }),
        );
      });

      it('rejects a PROHIBITED species', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        speciesRepository.findById.mockResolvedValue(buildSpecies({ regulatoryStatus: 'PROHIBITED' }));

        await expect(service.register('vendor-user-1', speciesDto)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(lotsRepository.create).not.toHaveBeenCalled();
      });

      it('rejects a catch date outside the seasonal window', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        speciesRepository.findById.mockResolvedValue(
          buildSpecies({ seasonalStartMonth: 6, seasonalEndMonth: 8 }),
        );

        await expect(service.register('vendor-user-1', speciesDto)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('throws when the species does not exist', async () => {
        vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
        speciesRepository.findById.mockResolvedValue(null);
        await expect(service.register('vendor-user-1', speciesDto)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    });
  });

  describe('assertSellable', () => {
    it('allows a Grade A lot with a passing score', () => {
      expect(() =>
        service.assertSellable({ freshnessGrade: 'GRADE_A', qualityScore: 95 }),
      ).not.toThrow();
    });

    it('rejects a Grade C lot', () => {
      expect(() =>
        service.assertSellable({ freshnessGrade: 'GRADE_C', qualityScore: 95 }),
      ).toThrow(BadRequestException);
    });

    it('rejects a REJECTED-grade lot', () => {
      expect(() =>
        service.assertSellable({ freshnessGrade: 'REJECTED', qualityScore: null }),
      ).toThrow(BadRequestException);
    });

    it('rejects a lot with a quality score below 60', () => {
      expect(() =>
        service.assertSellable({ freshnessGrade: 'GRADE_A', qualityScore: 59 }),
      ).toThrow(BadRequestException);
    });

    it('allows a lot with no grading yet', () => {
      expect(() =>
        service.assertSellable({ freshnessGrade: null, qualityScore: null }),
      ).not.toThrow();
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

    it('computes retentionExpiresAt as createdAt + 7 years', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ createdAt: new Date('2026-01-15T00:00:00.000Z') }));
      const result = await service.getById('lot-1');
      expect(result.retentionExpiresAt.toISOString()).toBe('2033-01-15T00:00:00.000Z');
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
      expect(result.catchLocation).toBe('North Coast');
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

      const result = await service.updateStatus('admin-1', 'lot-1', 'QUARANTINED', 'Cleared after review');

      expect(result.foodSafetyStatus).toBe('QUARANTINED');
      expect(lotsRepository.updateStatus).toHaveBeenCalledWith('lot-1', 'QUARANTINED', 'Cleared after review');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'SEAFOOD_LOT_STATUS_UPDATED',
          entityType: 'SeafoodLot',
          entityId: 'lot-1',
        }),
      );
    });

    it('throws when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('admin-1', 'missing', 'SAFE')).rejects.toBeInstanceOf(NotFoundException);
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
