import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  CatalogueRetirementReason,
  RegulatoryOverrideReason,
  RegulatoryStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  CatalogueItemWithDetails,
  SeafoodCatalogueRepository,
} from '../repositories/seafood-catalogue.repository';
import { SeafoodCatalogueService } from '../services/seafood-catalogue.service';

describe('SeafoodCatalogueService (Phase 16A)', () => {
  let service: SeafoodCatalogueService;
  let mockRepository: jest.Mocked<Partial<SeafoodCatalogueRepository>>;
  let mockPrisma: any;

  const mockCategory = { id: 'cat-1', name: 'Fish', slug: 'fish' };
  const mockSpecies1 = {
    id: 'sp-1',
    scientificName: 'Lutjanus analis',
    commercialName: 'Snapper',
    regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
  };
  const mockSpecies2 = {
    id: 'sp-2',
    scientificName: 'Scomberomorus cavalla',
    commercialName: 'King Fish',
    regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
  };

  const createMockItem = (
    overrides: Partial<CatalogueItemWithDetails> = {},
  ): CatalogueItemWithDetails => ({
    id: 'item-1',
    name: 'Red Snapper',
    scientificName: 'Lutjanus analis',
    scientificFamily: 'Lutjanidae',
    commonName: 'Mutton Snapper',
    jamaicanNames: ['Redman'],
    description: 'Fresh reef fish',
    categoryId: 'cat-1',
    compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
    lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
    retirementReason: null,
    retirementNotes: null,
    consolidatedIntoId: null,
    referenceImageUrl: null,
    imageSourceLicense: null,
    typicalUnit: 'PER_POUND' as any,
    typicalSizeMinCm: null,
    typicalSizeMaxCm: null,
    typicalWeightMinLbs: null,
    typicalWeightMaxLbs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: mockCategory as any,
    speciesLinks: [
      {
        catalogueItemId: 'item-1',
        speciesId: 'sp-1',
        isPrimary: true,
        typicalProportion: null,
        createdAt: new Date(),
        species: mockSpecies1 as any,
      },
    ],
    regulatoryOverrides: [],
    consolidatedInto: null,
    ...overrides,
  });

  beforeEach(async () => {
    mockRepository = {
      findById: jest.fn(),
      findByName: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      createOverride: jest.fn(),
      findOverrideById: jest.fn(),
      approveOverride: jest.fn(),
    };

    mockPrisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue(mockCategory),
      },
      species: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const ids: string[] = where?.id?.in ?? [];
          return Promise.resolve([mockSpecies1, mockSpecies2].filter((s) => ids.includes(s.id)));
        }),
      },
      seafoodCatalogueItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeafoodCatalogueService,
        { provide: SeafoodCatalogueRepository, useValue: mockRepository },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SeafoodCatalogueService>(SeafoodCatalogueService);
  });

  describe('1. Catalogue Creation and Composition Validation', () => {
    it('creates a SINGLE_SPECIES catalogue item in DRAFT status', async () => {
      const dto = {
        name: 'Red Snapper',
        commonName: 'Mutton Snapper',
        categoryId: 'cat-1',
        compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
        species: [{ speciesId: 'sp-1', isPrimary: true }],
      };

      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);
      const expectedItem = createMockItem();
      (mockRepository.create as jest.Mock).mockResolvedValue(expectedItem);

      const result = await service.create(dto);
      expect(result.id).toBe('item-1');
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Red Snapper', compositionMode: CatalogueCompositionMode.SINGLE_SPECIES }),
        dto.species,
      );
    });

    it('rejects creation if category does not exist', async () => {
      mockPrisma.category.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Snapper',
          commonName: 'Snapper',
          categoryId: 'non-existent',
          compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
          species: [{ speciesId: 'sp-1' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects duplicate catalogue item name', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(createMockItem());

      await expect(
        service.create({
          name: 'Red Snapper',
          commonName: 'Red Snapper',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
          species: [{ speciesId: 'sp-1' }],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects SINGLE_SPECIES with multiple species', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Invalid Item',
          commonName: 'Invalid',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
          species: [{ speciesId: 'sp-1' }, { speciesId: 'sp-2' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects FIXED_COMPOSITE with only 1 species', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Mixed Pack',
          commonName: 'Mixed Pack',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.FIXED_COMPOSITE,
          species: [{ speciesId: 'sp-1' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects UNVERIFIED_COMPOSITION with species links', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Unverified Catch',
          commonName: 'Unknown',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.UNVERIFIED_COMPOSITION,
          species: [{ speciesId: 'sp-1' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects species links with duplicate IDs', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({
          name: 'Mixed',
          commonName: 'Mixed',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.FIXED_COMPOSITE,
          species: [{ speciesId: 'sp-1' }, { speciesId: 'sp-1' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects species links with non-existent species IDs', async () => {
      (mockRepository.findByName as jest.Mock).mockResolvedValue(null);
      mockPrisma.species.findMany.mockResolvedValue([mockSpecies1]); // Only 1 found instead of 2

      await expect(
        service.create({
          name: 'Mixed',
          commonName: 'Mixed',
          categoryId: 'cat-1',
          compositionMode: CatalogueCompositionMode.FIXED_COMPOSITE,
          species: [{ speciesId: 'sp-1' }, { speciesId: 'sp-missing' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. Catalogue Lifecycle State Machine', () => {
    it('submits DRAFT item for review when composition is valid', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.DRAFT });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.update as jest.Mock).mockResolvedValue({
        ...item,
        lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW,
      });

      const updated = await service.submitForReview(item.id);
      expect(updated.lifecycleStatus).toBe(CatalogueLifecycleStatus.UNDER_REVIEW);
      expect(mockRepository.update).toHaveBeenCalledWith(item.id, {
        lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW,
      });
    });

    it('rejects submission for review if item is UNVERIFIED_COMPOSITION', async () => {
      const item = createMockItem({
        compositionMode: CatalogueCompositionMode.UNVERIFIED_COMPOSITION,
        speciesLinks: [],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      await expect(service.submitForReview(item.id)).rejects.toThrow(BadRequestException);
    });

    it('rejects submission for review if current status is not DRAFT', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      await expect(service.submitForReview(item.id)).rejects.toThrow(BadRequestException);
    });

    it('approves UNDER_REVIEW item to PUBLISHED', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.update as jest.Mock).mockResolvedValue({
        ...item,
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      });

      const approved = await service.approve(item.id);
      expect(approved.lifecycleStatus).toBe(CatalogueLifecycleStatus.PUBLISHED);
    });

    it('rejects approval if item is not UNDER_REVIEW', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.DRAFT });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      await expect(service.approve(item.id)).rejects.toThrow(BadRequestException);
    });

    it('rejects UNDER_REVIEW item back to DRAFT', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.update as jest.Mock).mockResolvedValue({
        ...item,
        lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
      });

      const rejected = await service.reject(item.id, 'Need better photo');
      expect(rejected.lifecycleStatus).toBe(CatalogueLifecycleStatus.DRAFT);
    });
  });

  describe('3. Retirement and Duplicate Consolidation', () => {
    it('retires a PUBLISHED item with COMMERCIAL_RETIREMENT reason', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.update as jest.Mock).mockResolvedValue({
        ...item,
        lifecycleStatus: CatalogueLifecycleStatus.RETIRED,
        retirementReason: CatalogueRetirementReason.COMMERCIAL_RETIREMENT,
      });

      const retired = await service.retire(item.id, {
        retirementReason: CatalogueRetirementReason.COMMERCIAL_RETIREMENT,
      });
      expect(retired.lifecycleStatus).toBe(CatalogueLifecycleStatus.RETIRED);
    });

    it('rejects retirement if current status is not PUBLISHED', async () => {
      const item = createMockItem({ lifecycleStatus: CatalogueLifecycleStatus.DRAFT });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      await expect(
        service.retire(item.id, {
          retirementReason: CatalogueRetirementReason.COMMERCIAL_RETIREMENT,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('retires with DUPLICATE_CONSOLIDATION when target is valid', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({ id: 'item-2', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      (mockRepository.update as jest.Mock).mockResolvedValue({
        ...item,
        lifecycleStatus: CatalogueLifecycleStatus.RETIRED,
        retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
        consolidatedIntoId: 'item-2',
      });

      const retired = await service.retire('item-1', {
        retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
        consolidatedIntoId: 'item-2',
      });
      expect(retired.consolidatedIntoId).toBe('item-2');
    });

    it('rejects consolidation if target item is self', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects consolidation if target category differs', async () => {
      const item = createMockItem({ id: 'item-1', categoryId: 'cat-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({ id: 'item-2', categoryId: 'cat-different', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-2',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects consolidation if target item is RETIRED', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({ id: 'item-2', lifecycleStatus: CatalogueLifecycleStatus.RETIRED });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-2',
        }),
      ).rejects.toThrow(
        new BadRequestException('Cannot consolidate into an already RETIRED catalogue item'),
      );
    });

    it('rejects consolidation if target item is not PUBLISHED (e.g. DRAFT)', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({ id: 'item-2', lifecycleStatus: CatalogueLifecycleStatus.DRAFT });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-2',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects consolidation if target item is already consolidated into another item (chain prevention)', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({
        id: 'item-2',
        lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
        consolidatedIntoId: 'item-3',
      });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-2',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Consolidation target is already consolidated into another catalogue item; chaining consolidations is prohibited',
        ),
      );
    });

    it('rejects consolidation if target item was previously consolidated into source (cycle prevention)', async () => {
      const item = createMockItem({ id: 'item-1', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      const targetItem = createMockItem({ id: 'item-2', lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });

      (mockRepository.findById as jest.Mock).mockImplementation((id: string) => {
        if (id === 'item-1') return Promise.resolve(item);
        if (id === 'item-2') return Promise.resolve(targetItem);
        return Promise.resolve(null);
      });

      mockPrisma.seafoodCatalogueItem.findFirst.mockResolvedValue({ id: 'item-2', consolidatedIntoId: 'item-1' });

      await expect(
        service.retire('item-1', {
          retirementReason: CatalogueRetirementReason.DUPLICATE_CONSOLIDATION,
          consolidatedIntoId: 'item-2',
        }),
      ).rejects.toThrow(
        new BadRequestException('Consolidation cycle detected: target item is already consolidated into this item'),
      );
    });
  });

  describe('4. Regulatory Override Two-Party Authorization', () => {
    it('requests override in pending state with authenticated requester', async () => {
      const item = createMockItem();
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.createOverride as jest.Mock).mockResolvedValue({
        id: 'override-1',
        requestedByUserId: 'admin-requester',
        approvedByUserId: null,
      });

      const futureDate = new Date(Date.now() + 86400000);
      const result = await service.requestRegulatoryOverride('admin-requester', {
        catalogueItemId: item.id,
        reason: RegulatoryOverrideReason.DATA_CORRECTION,
        justification: 'Data sync fix',
        expiresAt: futureDate,
      });

      expect(result).toBeDefined();
      expect(mockRepository.createOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedByUserId: 'admin-requester',
          approvedByUserId: null,
        }),
      );
    });

    it('approves pending override when approver is a distinct administrator', async () => {
      const item = createMockItem();
      (mockRepository.findOverrideById as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: item.id,
        requestedByUserId: 'admin-requester',
        approvedByUserId: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);
      (mockRepository.approveOverride as jest.Mock).mockResolvedValue({
        id: 'override-1',
        requestedByUserId: 'admin-requester',
        approvedByUserId: 'admin-approver',
      });

      const result = await service.approveRegulatoryOverride('override-1', 'admin-approver');
      expect(result.approvedByUserId).toBe('admin-approver');
      expect(mockRepository.approveOverride).toHaveBeenCalledWith('override-1', 'admin-approver');
    });

    it('rejects self-approval (requester === approver)', async () => {
      (mockRepository.findOverrideById as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: 'item-1',
        requestedByUserId: 'same-admin',
        approvedByUserId: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(
        service.approveRegulatoryOverride('override-1', 'same-admin'),
      ).rejects.toThrow(
        new BadRequestException(
          'Regulatory override requires two-party authorization; requester cannot approve their own override',
        ),
      );
    });

    it('rejects approval if override is already approved', async () => {
      (mockRepository.findOverrideById as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: 'item-1',
        requestedByUserId: 'admin-1',
        approvedByUserId: 'admin-2',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(
        service.approveRegulatoryOverride('override-1', 'admin-3'),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects approval if override is expired', async () => {
      (mockRepository.findOverrideById as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: 'item-1',
        requestedByUserId: 'admin-1',
        approvedByUserId: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 10000),
      });

      await expect(
        service.approveRegulatoryOverride('override-1', 'admin-2'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects override if catalogue item has PROHIBITED species', async () => {
      const item = createMockItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.PROHIBITED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const futureDate = new Date(Date.now() + 86400000);
      await expect(
        service.requestRegulatoryOverride('admin-1', {
          catalogueItemId: item.id,
          reason: RegulatoryOverrideReason.DATA_CORRECTION,
          justification: 'Attempt bypass',
          expiresAt: futureDate,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
