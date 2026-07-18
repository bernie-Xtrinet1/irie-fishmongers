import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleName, SeafoodLot, Vendor, WasteDisposalRecord } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { ProductsService } from '../../products/services/products.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateWasteDisposalRecordDto } from '../dto/create-waste-disposal-record.dto';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { WasteDisposalRecordsRepository } from '../repositories/waste-disposal-records.repository';
import { WasteDisposalRecordsService } from './waste-disposal-records.service';

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
    complianceScoreUpdatedAt: null,
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
    catchDate: new Date(),
    catchLocation: null,
    landingSite: null,
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

function buildRecord(overrides: Partial<WasteDisposalRecord> = {}): WasteDisposalRecord {
  return {
    id: 'waste-1',
    lotId: 'lot-1',
    productId: null,
    recallId: null,
    quantity: { toString: () => '5' } as unknown as WasteDisposalRecord['quantity'],
    weightUnit: 'POUNDS',
    reason: 'SPOILAGE',
    disposalMethod: null,
    evidencePhotoUrls: [],
    witnessName: null,
    witnessTitle: null,
    witnessSignatureUrl: null,
    recordedById: 'vendor-user-1',
    disposedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WasteDisposalRecordsService', () => {
  let wasteDisposalRecordsRepository: jest.Mocked<Pick<WasteDisposalRecordsRepository, 'create' | 'findMany'>>;
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let productsService: jest.Mocked<Pick<ProductsService, 'adjustStockForDisposal'>>;
  let custodyEventsRepository: jest.Mocked<Pick<CustodyEventsRepository, 'create'>>;
  let service: WasteDisposalRecordsService;

  const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: [RoleName.VENDOR] };
  const adminUser: RequestUser = { id: 'admin-1', email: 'admin@example.com', roles: [RoleName.ADMINISTRATOR] };

  beforeEach(() => {
    wasteDisposalRecordsRepository = { create: jest.fn(), findMany: jest.fn() };
    lotsRepository = { findById: jest.fn() };
    vendorsRepository = { findByUserId: jest.fn() };
    productsService = { adjustStockForDisposal: jest.fn() };
    custodyEventsRepository = { create: jest.fn() };

    service = new WasteDisposalRecordsService(
      wasteDisposalRecordsRepository as unknown as WasteDisposalRecordsRepository,
      lotsRepository as unknown as SeafoodLotsRepository,
      vendorsRepository as unknown as VendorsRepository,
      productsService as unknown as ProductsService,
      custodyEventsRepository as unknown as CustodyEventsRepository,
    );
  });

  describe('create', () => {
    const dto: CreateWasteDisposalRecordDto = {
      lotId: 'lot-1',
      quantity: 5,
      weightUnit: 'POUNDS',
      reason: 'SPOILAGE',
    };

    it('throws when the lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.create(vendorUser, dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a vendor recording disposal for a lot they do not own', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ vendorId: 'someone-elses-vendor' }));
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ id: 'vendor-1' }));

      await expect(service.create(vendorUser, dto)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the owning vendor to record disposal', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      wasteDisposalRecordsRepository.create.mockResolvedValue(buildRecord());

      const result = await service.create(vendorUser, dto);

      expect(result.id).toBe('waste-1');
      expect(custodyEventsRepository.create).toHaveBeenCalledWith({
        lotId: 'lot-1',
        eventType: 'DISPOSAL',
        fromUserId: 'vendor-user-1',
      });
    });

    it('allows an admin to bypass the ownership check', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot({ vendorId: 'some-vendor' }));
      wasteDisposalRecordsRepository.create.mockResolvedValue(buildRecord());

      await service.create(adminUser, dto);

      expect(vendorsRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('rejects RECALL_DESTRUCTION without a witnessName', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());

      await expect(
        service.create(vendorUser, { ...dto, reason: 'RECALL_DESTRUCTION' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(wasteDisposalRecordsRepository.create).not.toHaveBeenCalled();
    });

    it('accepts RECALL_DESTRUCTION with a witnessName', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      wasteDisposalRecordsRepository.create.mockResolvedValue(
        buildRecord({ reason: 'RECALL_DESTRUCTION', witnessName: 'J. Brown' }),
      );

      const result = await service.create(vendorUser, {
        ...dto,
        reason: 'RECALL_DESTRUCTION',
        witnessName: 'J. Brown',
      });

      expect(result.witnessName).toBe('J. Brown');
    });

    it('decrements product stock and writes a DISPOSED event when productId is supplied', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      wasteDisposalRecordsRepository.create.mockResolvedValue(buildRecord({ productId: 'product-1' }));

      await service.create(vendorUser, { ...dto, productId: 'product-1', quantity: 5 });

      expect(productsService.adjustStockForDisposal).toHaveBeenCalledWith('product-1', -5, 'vendor-user-1');
    });

    it('does not touch product stock when no productId is supplied', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      wasteDisposalRecordsRepository.create.mockResolvedValue(buildRecord());

      await service.create(vendorUser, dto);

      expect(productsService.adjustStockForDisposal).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists records filtered by lotId', async () => {
      wasteDisposalRecordsRepository.findMany.mockResolvedValue([buildRecord()]);

      const result = await service.list({ lotId: 'lot-1' });

      expect(result).toHaveLength(1);
      expect(wasteDisposalRecordsRepository.findMany).toHaveBeenCalledWith({ lotId: 'lot-1' });
    });
  });
});
