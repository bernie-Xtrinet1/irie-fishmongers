import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Vendor, VendorDowngradeEvent, VendorUpgradeRequest } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DowngradeVendorDto } from '../dto/downgrade-vendor.dto';
import { ListUpgradeRequestsDto } from '../dto/list-upgrade-requests.dto';
import { RequestTierUpgradeDto } from '../dto/request-tier-upgrade.dto';
import { ReviewUpgradeRequestDto } from '../dto/review-upgrade-request.dto';
import { VendorDowngradeEventsRepository } from '../repositories/vendor-downgrade-events.repository';
import { VendorUpgradeRequestsRepository } from '../repositories/vendor-upgrade-requests.repository';
import { VendorDocumentsService } from './vendor-documents.service';
import { VendorTiersService } from './vendor-tiers.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
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

function buildUpgradeRequest(overrides: Partial<VendorUpgradeRequest> = {}): VendorUpgradeRequest {
  return {
    id: 'request-1',
    vendorId: 'vendor-1',
    requestedTier: 'VERIFIED_VENDOR',
    status: 'PENDING',
    reason: null,
    reviewedById: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildDowngradeEvent(overrides: Partial<VendorDowngradeEvent> = {}): VendorDowngradeEvent {
  return {
    id: 'event-1',
    vendorId: 'vendor-1',
    fromTier: 'VERIFIED_VENDOR',
    toTier: 'COMMUNITY_FISHER',
    reason: 'ADMIN_MANUAL',
    triggeredById: 'admin-1',
    notes: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('VendorTiersService', () => {
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId' | 'findById' | 'updateTier'>>;
  let upgradeRequestsRepository: jest.Mocked<
    Pick<VendorUpgradeRequestsRepository, 'create' | 'findById' | 'findPendingByVendorId' | 'updateStatus' | 'findMany'>
  >;
  let downgradeEventsRepository: jest.Mocked<
    Pick<VendorDowngradeEventsRepository, 'create' | 'findByVendorId'>
  >;
  let documentsService: jest.Mocked<Pick<VendorDocumentsService, 'computeCanSell'>>;
  let service: VendorTiersService;

  beforeEach(() => {
    vendorsRepository = { findByUserId: jest.fn(), findById: jest.fn(), updateTier: jest.fn() };
    upgradeRequestsRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findPendingByVendorId: jest.fn(),
      updateStatus: jest.fn(),
      findMany: jest.fn(),
    };
    downgradeEventsRepository = { create: jest.fn(), findByVendorId: jest.fn() };
    documentsService = { computeCanSell: jest.fn() };

    service = new VendorTiersService(
      vendorsRepository as unknown as VendorsRepository,
      upgradeRequestsRepository as unknown as VendorUpgradeRequestsRepository,
      downgradeEventsRepository as unknown as VendorDowngradeEventsRepository,
      documentsService as unknown as VendorDocumentsService,
    );
  });

  describe('requestUpgrade', () => {
    const dto: RequestTierUpgradeDto = { requestedTier: 'VERIFIED_VENDOR' };

    it('creates an upgrade request when the requested tier outranks the current tier', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ tier: 'COMMUNITY_FISHER' }));
      upgradeRequestsRepository.findPendingByVendorId.mockResolvedValue(null);
      upgradeRequestsRepository.create.mockResolvedValue(buildUpgradeRequest());

      const result = await service.requestUpgrade('user-1', dto);

      expect(result.id).toBe('request-1');
      expect(upgradeRequestsRepository.create).toHaveBeenCalledWith({
        vendorId: 'vendor-1',
        requestedTier: 'VERIFIED_VENDOR',
        reason: undefined,
      });
    });

    it('throws BadRequestException when the requested tier is the same as the current tier', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ tier: 'VERIFIED_VENDOR' }));

      await expect(service.requestUpgrade('user-1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(upgradeRequestsRepository.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the requested tier is lower than the current tier', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ tier: 'COMMERCIAL_SUPPLIER' }));

      await expect(service.requestUpgrade('user-1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws ConflictException when the vendor already has a pending request', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor({ tier: 'COMMUNITY_FISHER' }));
      upgradeRequestsRepository.findPendingByVendorId.mockResolvedValue(buildUpgradeRequest());

      await expect(service.requestUpgrade('user-1', dto)).rejects.toBeInstanceOf(ConflictException);
      expect(upgradeRequestsRepository.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.requestUpgrade('user-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listUpgradeRequests', () => {
    it('paginates upgrade requests filtered by status', async () => {
      upgradeRequestsRepository.findMany.mockResolvedValue({ items: [buildUpgradeRequest()], total: 1 });

      const dto: ListUpgradeRequestsDto = { page: 1, pageSize: 20, status: 'PENDING' };
      const result = await service.listUpgradeRequests(dto);

      expect(result.total).toBe(1);
      expect(upgradeRequestsRepository.findMany).toHaveBeenCalledWith('PENDING', { skip: 0, take: 20 });
    });

    it('computes skip from page and pageSize', async () => {
      upgradeRequestsRepository.findMany.mockResolvedValue({ items: [], total: 0 });

      await service.listUpgradeRequests({ page: 3, pageSize: 10 });

      expect(upgradeRequestsRepository.findMany).toHaveBeenCalledWith(undefined, { skip: 20, take: 10 });
    });
  });

  describe('reviewUpgradeRequest', () => {
    it('rejects a pending request without touching the vendor tier or checking documents', async () => {
      upgradeRequestsRepository.findById.mockResolvedValue(buildUpgradeRequest({ status: 'PENDING' }));
      upgradeRequestsRepository.updateStatus.mockResolvedValue(
        buildUpgradeRequest({ status: 'REJECTED' }),
      );

      const dto: ReviewUpgradeRequestDto = { decision: 'REJECTED', reviewNotes: 'Not eligible yet' };
      const result = await service.reviewUpgradeRequest('admin-1', 'request-1', dto);

      expect(result.status).toBe('REJECTED');
      expect(documentsService.computeCanSell).not.toHaveBeenCalled();
      expect(vendorsRepository.updateTier).not.toHaveBeenCalled();
      expect(upgradeRequestsRepository.updateStatus).toHaveBeenCalledWith('request-1', 'REJECTED', {
        reviewedById: 'admin-1',
        reviewedAt: expect.any(Date) as Date,
        reviewNotes: 'Not eligible yet',
      });
    });

    it('approves a pending request and updates the vendor tier when documents check out', async () => {
      upgradeRequestsRepository.findById.mockResolvedValue(
        buildUpgradeRequest({ status: 'PENDING', requestedTier: 'VERIFIED_VENDOR' }),
      );
      documentsService.computeCanSell.mockResolvedValue(true);
      upgradeRequestsRepository.updateStatus.mockResolvedValue(
        buildUpgradeRequest({ status: 'APPROVED' }),
      );
      vendorsRepository.updateTier.mockResolvedValue(buildVendor({ tier: 'VERIFIED_VENDOR' }));

      const dto: ReviewUpgradeRequestDto = { decision: 'APPROVED' };
      const result = await service.reviewUpgradeRequest('admin-1', 'request-1', dto);

      expect(result.status).toBe('APPROVED');
      expect(documentsService.computeCanSell).toHaveBeenCalledWith('vendor-1', 'VERIFIED_VENDOR');
      expect(vendorsRepository.updateTier).toHaveBeenCalledWith('vendor-1', 'VERIFIED_VENDOR');
    });

    it('throws BadRequestException on approval when the requested-tier documents are not satisfied', async () => {
      upgradeRequestsRepository.findById.mockResolvedValue(
        buildUpgradeRequest({ status: 'PENDING', requestedTier: 'VERIFIED_VENDOR' }),
      );
      documentsService.computeCanSell.mockResolvedValue(false);

      const dto: ReviewUpgradeRequestDto = { decision: 'APPROVED' };
      await expect(service.reviewUpgradeRequest('admin-1', 'request-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(upgradeRequestsRepository.updateStatus).not.toHaveBeenCalled();
      expect(vendorsRepository.updateTier).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the request is not PENDING', async () => {
      upgradeRequestsRepository.findById.mockResolvedValue(buildUpgradeRequest({ status: 'APPROVED' }));

      const dto: ReviewUpgradeRequestDto = { decision: 'APPROVED' };
      await expect(service.reviewUpgradeRequest('admin-1', 'request-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFoundException when the request does not exist', async () => {
      upgradeRequestsRepository.findById.mockResolvedValue(null);

      const dto: ReviewUpgradeRequestDto = { decision: 'APPROVED' };
      await expect(service.reviewUpgradeRequest('admin-1', 'missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('downgrade', () => {
    const dto: DowngradeVendorDto = { toTier: 'COMMUNITY_FISHER', reason: 'ADMIN_MANUAL' };

    it('creates a downgrade event and updates the vendor tier when toTier is strictly lower', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ tier: 'VERIFIED_VENDOR' }));
      downgradeEventsRepository.create.mockResolvedValue(buildDowngradeEvent());
      vendorsRepository.updateTier.mockResolvedValue(buildVendor({ tier: 'COMMUNITY_FISHER' }));

      const result = await service.downgrade('admin-1', 'vendor-1', dto);

      expect(result.id).toBe('event-1');
      expect(downgradeEventsRepository.create).toHaveBeenCalledWith({
        vendorId: 'vendor-1',
        fromTier: 'VERIFIED_VENDOR',
        toTier: 'COMMUNITY_FISHER',
        reason: 'ADMIN_MANUAL',
        triggeredById: 'admin-1',
        notes: undefined,
      });
      expect(vendorsRepository.updateTier).toHaveBeenCalledWith('vendor-1', 'COMMUNITY_FISHER');
    });

    it('throws BadRequestException when toTier is the same as the current tier', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ tier: 'COMMUNITY_FISHER' }));

      await expect(service.downgrade('admin-1', 'vendor-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(downgradeEventsRepository.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when toTier is higher than the current tier', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ tier: 'COMMUNITY_FISHER' }));

      await expect(
        service.downgrade('admin-1', 'vendor-1', { toTier: 'VERIFIED_VENDOR', reason: 'ADMIN_MANUAL' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when the vendor does not exist', async () => {
      vendorsRepository.findById.mockResolvedValue(null);

      await expect(service.downgrade('admin-1', 'missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listDowngradeEvents', () => {
    it('paginates downgrade events for a vendor', async () => {
      downgradeEventsRepository.findByVendorId.mockResolvedValue({
        items: [buildDowngradeEvent()],
        total: 1,
      });

      const result = await service.listDowngradeEvents('vendor-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(downgradeEventsRepository.findByVendorId).toHaveBeenCalledWith('vendor-1', {
        skip: 0,
        take: 20,
      });
    });

    it('computes skip from page and pageSize', async () => {
      downgradeEventsRepository.findByVendorId.mockResolvedValue({ items: [], total: 0 });

      await service.listDowngradeEvents('vendor-1', { page: 2, pageSize: 5 });

      expect(downgradeEventsRepository.findByVendorId).toHaveBeenCalledWith('vendor-1', {
        skip: 5,
        take: 5,
      });
    });
  });
});
