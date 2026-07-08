import { NotFoundException } from '@nestjs/common';
import { RoleName, Vendor } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { VendorComplianceStatusEntity } from '../entities/vendor-compliance-status.entity';
import { VendorPermissionsEntity } from '../entities/vendor-permissions.entity';
import { VendorDocumentsService } from '../services/vendor-documents.service';
import { VendorPermissionsService } from '../services/vendor-permissions.service';
import { VendorPermissionsController } from './vendor-permissions.controller';

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

const permissions: VendorPermissionsEntity = {
  tier: 'COMMUNITY_FISHER',
  badge: '🐟 Community Fisher',
  dailySalesLimit: '50000',
  monthlySalesLimit: '500000',
  maxActiveListings: 50,
  canSellRetail: true,
  canSellWholesale: false,
  canAcceptHotelOrders: false,
  canAcceptRestaurantOrders: false,
  canAcceptGovernmentOrders: false,
  canExportProducts: false,
  canAccessAnalytics: false,
  canAccessPromotions: false,
  canUseApiAccess: false,
  canOperateMultipleZones: false,
};

const complianceStatus: VendorComplianceStatusEntity = {
  tier: 'COMMUNITY_FISHER',
  canSell: false,
  requiredDocuments: [{ type: 'GOVERNMENT_ID', status: 'MISSING' }],
};

const vendorUser: RequestUser = { id: 'user-1', email: 'vera@example.com', roles: [RoleName.VENDOR] };

describe('VendorPermissionsController', () => {
  let permissionsService: jest.Mocked<Pick<VendorPermissionsService, 'getPermissions'>>;
  let documentsService: jest.Mocked<Pick<VendorDocumentsService, 'getComplianceStatus'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId' | 'findById'>>;
  let controller: VendorPermissionsController;

  beforeEach(() => {
    permissionsService = { getPermissions: jest.fn().mockResolvedValue(permissions) };
    documentsService = { getComplianceStatus: jest.fn().mockResolvedValue(complianceStatus) };
    vendorsRepository = { findByUserId: jest.fn(), findById: jest.fn() };
    controller = new VendorPermissionsController(
      permissionsService as unknown as VendorPermissionsService,
      documentsService as unknown as VendorDocumentsService,
      vendorsRepository as unknown as VendorsRepository,
    );
  });

  describe('getMine', () => {
    it("returns the authenticated vendor's permissions", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());

      const result = await controller.getMine(vendorUser);

      expect(result).toEqual(permissions);
      expect(permissionsService.getPermissions).toHaveBeenCalledWith('COMMUNITY_FISHER');
    });

    it('throws NotFoundException when the caller has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(controller.getMine(vendorUser)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMyComplianceStatus', () => {
    it("returns the authenticated vendor's compliance status", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());

      const result = await controller.getMyComplianceStatus(vendorUser);

      expect(result).toEqual(complianceStatus);
      expect(documentsService.getComplianceStatus).toHaveBeenCalledWith(
        'vendor-1',
        'COMMUNITY_FISHER',
      );
    });

    it('throws NotFoundException when the caller has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(controller.getMyComplianceStatus(vendorUser)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getForVendor', () => {
    it("returns a given vendor's permissions", async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor({ tier: 'ENTERPRISE_SUPPLIER' }));

      const result = await controller.getForVendor('vendor-1');

      expect(result).toEqual(permissions);
      expect(permissionsService.getPermissions).toHaveBeenCalledWith('ENTERPRISE_SUPPLIER');
    });

    it('throws NotFoundException when the vendor does not exist', async () => {
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(controller.getForVendor('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
