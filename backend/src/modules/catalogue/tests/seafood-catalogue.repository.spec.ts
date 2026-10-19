import { BadRequestException } from '@nestjs/common';
import { CatalogueLifecycleStatus, CatalogueCompositionMode, ProductUnit } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { SeafoodCatalogueRepository } from '../repositories/seafood-catalogue.repository';

describe('SeafoodCatalogueRepository Concurrency & Consolidation (F-16B-03)', () => {
  let repository: SeafoodCatalogueRepository;
  let prisma: jest.Mocked<PrismaService>;
  let mockTx: any;
  let lockedIds: string[];

  const baseItem = {
    id: 'item-1',
    name: 'Snapper',
    scientificName: 'Lutjanus campechanus',
    scientificFamily: 'Lutjanidae',
    commonName: 'Red Snapper',
    jamaicanNames: ['Red Snapper'],
    description: null,
    categoryId: 'cat-1',
    compositionMode: CatalogueCompositionMode.SINGLE_SPECIES,
    lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
    retirementReason: null,
    retirementNotes: null,
    consolidatedIntoId: null,
    referenceImageUrl: 'https://example.com/img.jpg',
    imageSourceLicense: 'Public',
    typicalUnit: ProductUnit.PER_POUND,
    typicalSizeMinCm: null,
    typicalSizeMaxCm: null,
    typicalWeightMinLbs: null,
    typicalWeightMaxLbs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: { id: 'cat-1', name: 'Fish', slug: 'fish', createdAt: new Date(), updatedAt: new Date() },
    speciesLinks: [],
    regulatoryOverrides: [],
    consolidatedInto: null,
  };

  beforeEach(() => {
    lockedIds = [];
    mockTx = {
      $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray, ...values: any[]) => {
        // Capture locked IDs for lock-order verification
        if (values[0]) {
          lockedIds.push(values[0]);
        }
        return Promise.resolve([]);
      }),
      seafoodCatalogueItem: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue(baseItem),
        update: jest.fn().mockResolvedValue(baseItem),
      },
    };

    prisma = {
      $transaction: jest.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(mockTx)),
      seafoodCatalogueItem: mockTx.seafoodCatalogueItem,
    } as unknown as jest.Mocked<PrismaService>;

    repository = new SeafoodCatalogueRepository(prisma);
  });

  it('rejects self-referential consolidation', async () => {
    await expect(
      repository.update('item-1', { consolidatedIntoId: 'item-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation target cannot be self-referential.'));
  });

  it('enforces deterministic lexicographical row lock ordering to prevent deadlocks', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-zebra',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: null,
    });

    await repository.update('item-alpha', { consolidatedIntoId: 'target-zebra' });

    // Sorted lexicographically: item-alpha before target-zebra
    expect(lockedIds).toEqual(['item-alpha', 'target-zebra']);

    // Reverse order call: target-a vs item-z
    lockedIds = [];
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-a',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: null,
    });

    await repository.update('item-z', { consolidatedIntoId: 'target-a' });
    // Sorted lexicographically: item-z vs target-a -> target-a before item-z
    expect(lockedIds).toEqual(['item-z', 'target-a'].sort());
  });

  it('rejects consolidation if target does not exist', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue(null);

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-missing' }),
    ).rejects.toThrow(new BadRequestException('Consolidation target not found.'));
  });

  it('rejects consolidation into a RETIRED target', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.RETIRED,
      consolidatedIntoId: null,
    });

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation target must be in PUBLISHED status and not retired.'));
  });

  it('rejects consolidation into a DRAFT or non-PUBLISHED target', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
      consolidatedIntoId: null,
    });

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation target must be in PUBLISHED status and not retired.'));
  });

  it('rejects multi-hop consolidation chaining (target is already consolidated)', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: 'target-2',
    });

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation target must not be already consolidated into another item (chaining is prohibited).'));
  });

  it('rejects consolidation cycles where target was already consolidated into source', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: 'item-1',
    });

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation cycle detected: target item is already consolidated into this item.'));
  });

  it('rejects consolidation cycles where a reverse database link exists', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: null,
    });
    mockTx.seafoodCatalogueItem.findFirst.mockResolvedValue({ id: 'target-1', consolidatedIntoId: 'item-1' });

    await expect(
      repository.update('item-1', { consolidatedIntoId: 'target-1' }),
    ).rejects.toThrow(new BadRequestException('Consolidation cycle detected: target item is already consolidated into this item.'));
  });

  it('successfully consolidates when target is valid, published, unconsolidated and non-cyclical', async () => {
    mockTx.seafoodCatalogueItem.findUnique.mockResolvedValue({
      id: 'target-1',
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
      consolidatedIntoId: null,
    });
    mockTx.seafoodCatalogueItem.findFirst.mockResolvedValue(null);

    const result = await repository.update('item-1', { consolidatedIntoId: 'target-1' });

    expect(mockTx.seafoodCatalogueItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-1' },
        data: expect.objectContaining({
          consolidatedIntoId: 'target-1',
        }),
      }),
    );
    expect(result).toBeDefined();
  });
});
