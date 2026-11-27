import { Test, TestingModule } from '@nestjs/testing';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  ProductUnit,
  RegulatoryStatus,
} from '@prisma/client';

import { AdminSeafoodCatalogueController } from '../controllers/admin-seafood-catalogue.controller';
import { SeafoodCatalogueController } from '../controllers/seafood-catalogue.controller';
import { CatalogueItemWithDetails } from '../repositories/seafood-catalogue.repository';
import { RegulatoryEligibilityService } from '../services/regulatory-eligibility.service';
import { SeafoodCatalogueService } from '../services/seafood-catalogue.service';

describe('SeafoodCatalogue Controllers (Phase 16A)', () => {
  let publicController: SeafoodCatalogueController;
  let adminController: AdminSeafoodCatalogueController;
  let mockCatalogueService: jest.Mocked<Partial<SeafoodCatalogueService>>;
  let mockRegulatoryService: jest.Mocked<Partial<RegulatoryEligibilityService>>;

  const mockItem: CatalogueItemWithDetails = {
    id: 'item-1',
    name: 'Red Snapper',
    scientificName: 'Lutjanus analis',
    scientificFamily: 'Lutjanidae',
    commonName: 'Mutton Snapper',
    jamaicanNames: ['Redman'],
    description: 'Fresh reef fish',
    categoryId: 'cat-1',
    compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
    lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
    retirementReason: null,
    retirementNotes: null,
    consolidatedIntoId: null,
    referenceImageUrl: null,
    imageSourceLicense: null,
    typicalUnit: ProductUnit.PER_POUND,
    typicalSizeMinCm: null,
    typicalSizeMaxCm: null,
    typicalWeightMinLbs: null,
    typicalWeightMaxLbs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: {
      id: 'cat-1',
      name: 'Fish',
      slug: 'fish',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    speciesLinks: [
      {
        catalogueItemId: 'item-1',
        speciesId: 'sp-1',
        isPrimary: true,
        typicalProportion: null,
        createdAt: new Date(),
        species: {
          id: 'sp-1',
          scientificName: 'Lutjanus analis',
          commercialName: 'Snapper',
          regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
          seasonalStartMonth: null,
          seasonalEndMonth: null,
          minimumSizeCm: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ],
    regulatoryOverrides: [],
    consolidatedInto: null,
  };

  beforeEach(async () => {
    mockCatalogueService = {
      findMany: jest.fn().mockResolvedValue({ items: [mockItem], total: 1, page: 1, limit: 20 }),
      findById: jest.fn().mockResolvedValue(mockItem),
      create: jest.fn().mockResolvedValue(mockItem),
      update: jest.fn().mockResolvedValue(mockItem),
      submitForReview: jest.fn().mockResolvedValue({ ...mockItem, lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW }),
      approve: jest.fn().mockResolvedValue(mockItem),
      reject: jest.fn().mockResolvedValue({ ...mockItem, lifecycleStatus: CatalogueLifecycleStatus.DRAFT }),
      retire: jest.fn().mockResolvedValue({ ...mockItem, lifecycleStatus: CatalogueLifecycleStatus.RETIRED }),
      requestRegulatoryOverride: jest.fn().mockResolvedValue({ id: 'override-1' }),
      approveRegulatoryOverride: jest.fn().mockResolvedValue({ id: 'override-1' }),
      findApprovedPhotos: jest.fn().mockResolvedValue([
        {
          id: 'photo-tilapia-1',
          speciesId: 'sp-tilapia',
          catalogueItemId: 'cat-tilapia',
          title: 'Nile Tilapia / Red Belly (Oreochromis niloticus)',
          scientificName: 'Oreochromis niloticus',
          jamaicanAliases: ['Tilapia', 'Red Belly', 'Pond Fish'],
          imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
          sourceName: 'Wikimedia Commons',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
          photographer: 'Bjørn Christian Tørrissen',
          licenseName: 'CC BY-SA 3.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
          modifications: 'Cropped/resized to 900x600 PNG',
          requiresAttribution: true,
          approvalStatus: 'APPROVED',
          isDefault: true,
          versionGroupId: 'photo-tilapia-1',
          versionNumber: 1,
          retiredAt: null,
          species: {
            id: 'sp-tilapia',
            commercialName: 'Tilapia',
            scientificName: 'Oreochromis niloticus',
            regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
          },
        },
      ]),
      findPublicPhotoCredits: jest.fn().mockResolvedValue([
        {
          id: 'photo-tilapia-1',
          speciesId: 'sp-tilapia',
          catalogueItemId: 'cat-tilapia',
          title: 'Nile Tilapia / Red Belly (Oreochromis niloticus)',
          scientificName: 'Oreochromis niloticus',
          jamaicanAliases: ['Tilapia', 'Red Belly', 'Pond Fish'],
          imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
          sourceName: 'Wikimedia Commons',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
          photographer: 'Bjørn Christian Tørrissen',
          licenseName: 'CC BY-SA 3.0',
          licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
          modifications: 'Cropped/resized to 900x600 PNG',
          requiresAttribution: true,
          approvalStatus: 'APPROVED',
          isDefault: true,
          versionGroupId: 'photo-tilapia-1',
          versionNumber: 1,
          retiredAt: null,
          species: {
            id: 'sp-tilapia',
            commercialName: 'Tilapia',
            scientificName: 'Oreochromis niloticus',
            regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
          },
        },
      ]),
    };

    mockRegulatoryService = {
      evaluate: jest.fn().mockResolvedValue({
        eligible: true,
        reasons: [],
        evaluatedAt: new Date(),
        mode: 'ENFORCING',
      }),
    };

    publicController = new SeafoodCatalogueController(
      mockCatalogueService as any,
      mockRegulatoryService as any,
    );
    adminController = new AdminSeafoodCatalogueController(
      mockCatalogueService as any,
    );
  });

  describe('Public Browsing Controller', () => {
    it('browses published catalogue items', async () => {
      const res = await publicController.browse({ page: 1, limit: 20 });
      expect(res.data).toHaveLength(1);
      expect(res.data[0]!.id).toBe('item-1');
      expect(mockCatalogueService.findMany).toHaveBeenCalledWith({ page: 1, limit: 20 }, true);
    });

    it('gets published item by id', async () => {
      const res = await publicController.getById('item-1');
      expect(res.id).toBe('item-1');
      expect(mockCatalogueService.findById).toHaveBeenCalledWith('item-1', true);
    });

    it('lists approved species catalogue photos with rights and aliases', async () => {
      const res = await publicController.browsePhotos({ search: 'Red Belly' });
      expect(res).toHaveLength(1);
      expect(res[0]!.imageUrl).toBe('/catalogue-photos/oreochromis-niloticus.png');
      expect(res[0]!.licenseName).toBe('CC BY-SA 3.0');
      expect(mockCatalogueService.findApprovedPhotos).toHaveBeenCalledWith({
        search: 'Red Belly',
      });
    });

    it('lists public photo credits including active referenced versions', async () => {
      const res = await publicController.browsePhotoCredits();
      expect(res).toHaveLength(1);
      expect(res[0]!.isDefault).toBe(true);
      expect(mockCatalogueService.findPublicPhotoCredits).toHaveBeenCalled();
    });

    it('evaluates regulatory eligibility', async () => {
      const res = await publicController.evaluateRegulatory({ catalogueItemId: 'item-1' });
      expect(res.eligible).toBe(true);
      expect(mockRegulatoryService.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ catalogueItemId: 'item-1' }),
      );
    });
  });

  describe('Admin Controller', () => {
    it('creates draft catalogue item', async () => {
      const dto = {
        name: 'Snapper',
        commonName: 'Snapper',
        categoryId: 'cat-1',
        compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
      };
      const res = await adminController.create(dto);
      expect(res.id).toBe('item-1');
      expect(mockCatalogueService.create).toHaveBeenCalledWith(dto);
    });

    it('submits draft item for review', async () => {
      const res = await adminController.submitForReview('item-1');
      expect(res.lifecycleStatus).toBe(CatalogueLifecycleStatus.UNDER_REVIEW);
    });

    it('approves under-review item', async () => {
      const res = await adminController.approve('item-1');
      expect(res.lifecycleStatus).toBe(CatalogueLifecycleStatus.PUBLISHED);
    });

    it('rejects under-review item back to draft', async () => {
      const res = await adminController.reject('item-1', 'Need details');
      expect(res.lifecycleStatus).toBe(CatalogueLifecycleStatus.DRAFT);
    });

    it('retires published item', async () => {
      const res = await adminController.retire('item-1', {
        retirementReason: 'COMMERCIAL_RETIREMENT' as any,
      });
      expect(res.lifecycleStatus).toBe(CatalogueLifecycleStatus.RETIRED);
    });

    it('requests regulatory override deriving requester strictly from authenticated user', async () => {
      const dto = {
        catalogueItemId: 'item-1',
        reason: 'DATA_CORRECTION' as any,
        justification: 'Fix',
        expiresAt: new Date(Date.now() + 86400000),
      };
      const mockUser = { id: 'admin-requester', email: 'req@example.com', role: 'ADMINISTRATOR' } as any;
      const res = await adminController.requestOverride(mockUser, dto);
      expect(res).toBeDefined();
      expect(mockCatalogueService.requestRegulatoryOverride).toHaveBeenCalledWith(
        'admin-requester',
        dto,
      );
    });

    it('approves regulatory override with authenticated approver ID', async () => {
      const mockUser = { id: 'admin-approver', email: 'app@example.com', role: 'ADMINISTRATOR' } as any;
      const res = await adminController.approveOverride(mockUser, 'override-1');
      expect(res).toBeDefined();
      expect(mockCatalogueService.approveRegulatoryOverride).toHaveBeenCalledWith(
        'override-1',
        'admin-approver',
      );
    });
  });
});
