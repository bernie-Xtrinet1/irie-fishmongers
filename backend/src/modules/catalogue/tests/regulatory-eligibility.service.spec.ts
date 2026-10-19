import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  RegulatoryStatus,
} from '@prisma/client';

import {
  CatalogueItemWithDetails,
  SeafoodCatalogueRepository,
} from '../repositories/seafood-catalogue.repository';
import {
  RegulatoryEligibilityService,
  RegulatoryEvaluationContext,
} from '../services/regulatory-eligibility.service';

describe('RegulatoryEligibilityService (Phase 16A)', () => {
  let service: RegulatoryEligibilityService;
  let mockRepository: jest.Mocked<Partial<SeafoodCatalogueRepository>>;
  let mockConfigService: jest.Mocked<Partial<ConfigService>>;

  const createMockCatalogueItem = (
    overrides: Partial<CatalogueItemWithDetails> = {},
  ): CatalogueItemWithDetails => {
    return {
      id: 'cat-item-1',
      name: 'Jamaican Red Snapper',
      scientificName: 'Lutjanus analis',
      scientificFamily: 'Lutjanidae',
      commonName: 'Mutton Snapper',
      jamaicanNames: ['Redman', 'Snapper'],
      description: 'Prized reef fish',
      categoryId: 'cat-1',
      compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      retirementReason: null,
      retirementNotes: null,
      consolidatedIntoId: null,
      referenceImageUrl: 'https://cdn.example.com/snapper.jpg',
      imageSourceLicense: 'Public Domain',
      typicalUnit: 'PER_POUND' as any,
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
          catalogueItemId: 'cat-item-1',
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
      ...overrides,
    };
  };

  beforeEach(async () => {
    mockRepository = {
      findById: jest.fn(),
      findActiveOverride: jest.fn().mockResolvedValue(null),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue('ENFORCING'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegulatoryEligibilityService,
        { provide: SeafoodCatalogueRepository, useValue: mockRepository },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<RegulatoryEligibilityService>(RegulatoryEligibilityService);
  });

  describe('1. Safe-Mode Operation (ENFORCING vs DEGRADED_FAIL_CLOSED)', () => {
    it('evaluates normally when mode is ENFORCING', async () => {
      const item = createMockCatalogueItem();
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.mode).toBe('ENFORCING');
      expect(result.eligible).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('fails closed unconditionally when mode is DEGRADED_FAIL_CLOSED', async () => {
      (mockConfigService.get as jest.Mock).mockReturnValue('DEGRADED_FAIL_CLOSED');
      const item = createMockCatalogueItem();
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.mode).toBe('DEGRADED_FAIL_CLOSED');
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SERVICE_DEGRADED_FAIL_CLOSED');
      expect(mockRepository.findById).not.toHaveBeenCalled();
    });
  });

  describe('2. Missing or Stale Regulatory Data Handling', () => {
    it('returns fail-closed when catalogue item is not found', async () => {
      (mockRepository.findById as jest.Mock).mockResolvedValue(null);

      const result = await service.evaluate({ catalogueItemId: 'non-existent' });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('CATALOGUE_ITEM_NOT_FOUND');
    });

    it('returns fail-closed when database query fails with exception', async () => {
      (mockRepository.findById as jest.Mock).mockRejectedValue(new Error('Connection lost'));

      const result = await service.evaluate({ catalogueItemId: 'cat-item-1' });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('REGULATORY_DATA_UNAVAILABLE');
    });
  });

  describe('3. Catalogue Lifecycle Gating', () => {
    it.each([
      CatalogueLifecycleStatus.DRAFT,
      CatalogueLifecycleStatus.UNDER_REVIEW,
      CatalogueLifecycleStatus.RETIRED,
    ])('rejects catalogue item in %s status', async (status) => {
      const item = createMockCatalogueItem({ lifecycleStatus: status });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes(status))).toBe(true);
    });

    it('permits item in PUBLISHED status', async () => {
      const item = createMockCatalogueItem({ lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(true);
    });
  });

  describe('4. Composition Mode Structural Rules', () => {
    it('rejects UNVERIFIED_COMPOSITION pending administrator review', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.UNVERIFIED_COMPOSITION,
        speciesLinks: [],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('UNVERIFIED_COMPOSITION'))).toBe(true);
    });

    it('rejects SINGLE_SPECIES with 0 linked species', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
        speciesLinks: [],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('SINGLE_SPECIES composition requires exactly one'))).toBe(true);
    });

    it('rejects SINGLE_SPECIES with >1 linked species', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
        speciesLinks: [
          {
            catalogueItemId: 'cat-item-1',
            speciesId: 'sp-1',
            isPrimary: true,
            typicalProportion: null,
            createdAt: new Date(),
            species: {
              id: 'sp-1',
              scientificName: 'Species A',
              commercialName: 'Species A',
              regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
              seasonalStartMonth: null,
              seasonalEndMonth: null,
              minimumSizeCm: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            catalogueItemId: 'cat-item-1',
            speciesId: 'sp-2',
            isPrimary: false,
            typicalProportion: null,
            createdAt: new Date(),
            species: {
              id: 'sp-2',
              scientificName: 'Species B',
              commercialName: 'Species B',
              regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
              seasonalStartMonth: null,
              seasonalEndMonth: null,
              minimumSizeCm: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('found 2'))).toBe(true);
    });

    it('rejects FIXED_COMPOSITE with fewer than 2 species', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.FIXED_COMPOSITE,
        speciesLinks: [
          {
            catalogueItemId: 'cat-item-1',
            speciesId: 'sp-1',
            isPrimary: true,
            typicalProportion: null,
            createdAt: new Date(),
            species: {
              id: 'sp-1',
              scientificName: 'Species A',
              commercialName: 'Species A',
              regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
              seasonalStartMonth: null,
              seasonalEndMonth: null,
              minimumSizeCm: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('requires at least two linked species'))).toBe(true);
    });

    it('accepts FIXED_COMPOSITE with 2 or more species', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.FIXED_COMPOSITE,
        speciesLinks: [
          {
            catalogueItemId: 'cat-item-1',
            speciesId: 'sp-1',
            isPrimary: true,
            typicalProportion: null,
            createdAt: new Date(),
            species: {
              id: 'sp-1',
              scientificName: 'Species A',
              commercialName: 'Species A',
              regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
              seasonalStartMonth: null,
              seasonalEndMonth: null,
              minimumSizeCm: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          {
            catalogueItemId: 'cat-item-1',
            speciesId: 'sp-2',
            isPrimary: false,
            typicalProportion: null,
            createdAt: new Date(),
            species: {
              id: 'sp-2',
              scientificName: 'Species B',
              commercialName: 'Species B',
              regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
              seasonalStartMonth: null,
              seasonalEndMonth: null,
              minimumSizeCm: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(true);
    });

    it('rejects VARIABLE_COMPOSITE without catalogue species links or listing declaration', async () => {
      const item = createMockCatalogueItem({
        compositionMode: CatalogueCompositionMode.VARIABLE_COMPOSITE,
        speciesLinks: [],
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('VARIABLE_COMPOSITE item requires species declaration'))).toBe(true);
    });
  });

  describe('5. Species Prohibitions and Regulatory Status', () => {
    it('rejects legally PROHIBITED species', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.PROHIBITED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('legally prohibited from commercial trade'))).toBe(true);
    });

    it('flags RESTRICTED species with warning reason', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.RESTRICTED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons.some((r) => r.includes('RESTRICTED'))).toBe(true);
    });
  });

  describe('6. Closed-Season Month Boundaries', () => {
    it('enforces closed season within contiguous calendar months (e.g. Lobster April to June)', async () => {
      const item = createMockCatalogueItem();
      // Spiny Lobster closed season: open is July (7) to March (3), closed is April (4) to June (6)
      // Represent in schema: open season start=7, end=3 (wraps around) OR closed season representation
      // In schema: seasonalStartMonth/seasonalEndMonth represents the open season window
      item.speciesLinks[0]!.species.seasonalStartMonth = 7;
      item.speciesLinks[0]!.species.seasonalEndMonth = 3;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      // In May (month 5): outside open window (7-3) -> closed season!
      const mayDate = new Date('2026-05-15T12:00:00Z');
      const mayResult = await service.evaluate({ catalogueItemId: item.id, atDate: mayDate });
      expect(mayResult.eligible).toBe(false);
      expect(mayResult.reasons.some((r) => r.includes('closed season active for UTC month 5'))).toBe(true);

      // In August (month 8): inside open window (7-3) -> eligible!
      const augDate = new Date('2026-08-15T12:00:00Z');
      const augResult = await service.evaluate({ catalogueItemId: item.id, atDate: augDate });
      expect(augResult.eligible).toBe(true);

      // In January (month 1): inside open window (7-3) -> eligible!
      const janDate = new Date('2026-01-15T12:00:00Z');
      const janResult = await service.evaluate({ catalogueItemId: item.id, atDate: janDate });
      expect(janResult.eligible).toBe(true);
    });

    it('enforces open season within contiguous month range (e.g. start=3, end=8)', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.seasonalStartMonth = 3;
      item.speciesLinks[0]!.species.seasonalEndMonth = 8;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      // Month 5 (May) -> inside range -> eligible
      const mayDate = new Date('2026-05-01T00:00:00Z');
      const mayRes = await service.evaluate({ catalogueItemId: item.id, atDate: mayDate });
      expect(mayRes.eligible).toBe(true);

      // Month 11 (Nov) -> outside range -> closed season
      const novDate = new Date('2026-11-01T00:00:00Z');
      const novRes = await service.evaluate({ catalogueItemId: item.id, atDate: novDate });
      expect(novRes.eligible).toBe(false);
      expect(novRes.reasons.some((r) => r.includes('closed season active for UTC month 11'))).toBe(true);
    });
  });

  describe('7. Regulatory Override Workflow (Two-Party Separation and Expiry)', () => {
    it('applies legitimate DATA_CORRECTION override when two distinct users authorize it', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.RESTRICTED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      const futureDate = new Date(Date.now() + 86400000);
      (mockRepository.findActiveOverride as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: item.id,
        requestedByUserId: 'admin-requester',
        approvedByUserId: 'compliance-approver',
        reason: 'DATA_CORRECTION',
        expiresAt: futureDate,
      });

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(true);
      expect(result.details?.overrideApplied).toBe(true);
    });

    it('rejects override if requester and approver are the same user', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.RESTRICTED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      (mockRepository.findActiveOverride as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: item.id,
        requestedByUserId: 'same-user',
        approvedByUserId: 'same-user',
        reason: 'DATA_CORRECTION',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('Invalid regulatory override: two-party separation violated');
    });

    it('refuses to override a legal prohibition under any circumstance', async () => {
      const item = createMockCatalogueItem();
      item.speciesLinks[0]!.species.regulatoryStatus = RegulatoryStatus.PROHIBITED;
      (mockRepository.findById as jest.Mock).mockResolvedValue(item);

      (mockRepository.findActiveOverride as jest.Mock).mockResolvedValue({
        id: 'override-1',
        catalogueItemId: item.id,
        requestedByUserId: 'admin-requester',
        approvedByUserId: 'compliance-approver',
        reason: 'DATA_CORRECTION',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const result = await service.evaluate({ catalogueItemId: item.id });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('Legal prohibitions cannot be overridden under any circumstance');
    });
  });
});
