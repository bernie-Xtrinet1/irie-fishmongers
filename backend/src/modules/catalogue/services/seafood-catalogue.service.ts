import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  CatalogueRetirementReason,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CreateCatalogueItemDto } from '../dto/create-catalogue-item.dto';
import { CreateRegulatoryOverrideDto } from '../dto/create-regulatory-override.dto';
import { LinkSpeciesDto } from '../dto/link-species.dto';
import { QueryCatalogueDto } from '../dto/query-catalogue.dto';
import { RetireCatalogueItemDto } from '../dto/retire-catalogue-item.dto';
import { UpdateCatalogueItemDto } from '../dto/update-catalogue-item.dto';
import {
  CatalogueItemWithDetails,
  SeafoodCatalogueRepository,
} from '../repositories/seafood-catalogue.repository';

@Injectable()
export class SeafoodCatalogueService {
  constructor(
    private readonly repository: SeafoodCatalogueRepository,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreateCatalogueItemDto): Promise<CatalogueItemWithDetails> {
    // 1. Verify category exists
    const category = await this.prisma.category.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) {
      throw new BadRequestException('Category does not exist');
    }

    // 2. Validate composition rules
    await this.validateComposition(dto.compositionMode, dto.species);

    // 3. Check name uniqueness
    const existing = await this.repository.findByName(dto.name);
    if (existing) {
      throw new ConflictException(`Catalogue item with name "${dto.name}" already exists`);
    }

    return this.repository.create(
      {
        name: dto.name,
        scientificName: dto.scientificName,
        scientificFamily: dto.scientificFamily,
        commonName: dto.commonName,
        jamaicanNames: dto.jamaicanNames,
        description: dto.description,
        categoryId: dto.categoryId,
        compositionMode: dto.compositionMode,
        referenceImageUrl: dto.referenceImageUrl,
        imageSourceLicense: dto.imageSourceLicense,
        typicalUnit: dto.typicalUnit,
        typicalSizeMinCm: dto.typicalSizeMinCm,
        typicalSizeMaxCm: dto.typicalSizeMaxCm,
        typicalWeightMinLbs: dto.typicalWeightMinLbs,
        typicalWeightMaxLbs: dto.typicalWeightMaxLbs,
      },
      dto.species,
    );
  }

  async update(id: string, dto: UpdateCatalogueItemDto): Promise<CatalogueItemWithDetails> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (existing.lifecycleStatus === CatalogueLifecycleStatus.RETIRED) {
      throw new BadRequestException('Cannot edit a RETIRED catalogue item');
    }

    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new BadRequestException('Category does not exist');
      }
    }

    const effectiveMode = dto.compositionMode ?? existing.compositionMode;
    const effectiveSpecies = dto.species !== undefined
      ? dto.species
      : existing.speciesLinks.map((sl) => ({
          speciesId: sl.speciesId,
          isPrimary: sl.isPrimary,
          typicalProportion: sl.typicalProportion ? Number(sl.typicalProportion) : undefined,
        }));

    await this.validateComposition(effectiveMode, effectiveSpecies);

    if (dto.name && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await this.repository.findByName(dto.name);
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`Catalogue item with name "${dto.name}" already exists`);
      }
    }

    return this.repository.update(
      id,
      {
        name: dto.name,
        scientificName: dto.scientificName,
        scientificFamily: dto.scientificFamily,
        commonName: dto.commonName,
        jamaicanNames: dto.jamaicanNames,
        description: dto.description,
        categoryId: dto.categoryId,
        compositionMode: dto.compositionMode,
        referenceImageUrl: dto.referenceImageUrl,
        imageSourceLicense: dto.imageSourceLicense,
        typicalUnit: dto.typicalUnit,
        typicalSizeMinCm: dto.typicalSizeMinCm,
        typicalSizeMaxCm: dto.typicalSizeMaxCm,
        typicalWeightMinLbs: dto.typicalWeightMinLbs,
        typicalWeightMaxLbs: dto.typicalWeightMaxLbs,
      },
      dto.species,
    );
  }

  async submitForReview(id: string): Promise<CatalogueItemWithDetails> {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (item.lifecycleStatus !== CatalogueLifecycleStatus.DRAFT) {
      throw new BadRequestException(
        `Cannot submit for review: current status is ${item.lifecycleStatus} (must be DRAFT)`,
      );
    }

    if (item.compositionMode === CatalogueCompositionMode.UNVERIFIED_COMPOSITION) {
      throw new BadRequestException(
        'Cannot submit UNVERIFIED_COMPOSITION item for review; classification required',
      );
    }

    if (
      item.compositionMode === CatalogueCompositionMode.SINGLE_SPECIES &&
      item.speciesLinks.length !== 1
    ) {
      throw new BadRequestException(
        `SINGLE_SPECIES item must have exactly 1 species link before review; found ${item.speciesLinks.length}`,
      );
    }

    if (
      item.compositionMode === CatalogueCompositionMode.FIXED_COMPOSITE &&
      item.speciesLinks.length < 2
    ) {
      throw new BadRequestException(
        `FIXED_COMPOSITE item must have at least 2 species links before review; found ${item.speciesLinks.length}`,
      );
    }

    return this.repository.update(id, {
      lifecycleStatus: CatalogueLifecycleStatus.UNDER_REVIEW,
    });
  }

  async approve(id: string): Promise<CatalogueItemWithDetails> {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (item.lifecycleStatus !== CatalogueLifecycleStatus.UNDER_REVIEW) {
      throw new BadRequestException(
        `Cannot approve: current status is ${item.lifecycleStatus} (must be UNDER_REVIEW)`,
      );
    }

    return this.repository.update(id, {
      lifecycleStatus: CatalogueLifecycleStatus.PUBLISHED,
    });
  }

  async reject(id: string, notes?: string): Promise<CatalogueItemWithDetails> {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (item.lifecycleStatus !== CatalogueLifecycleStatus.UNDER_REVIEW) {
      throw new BadRequestException(
        `Cannot reject: current status is ${item.lifecycleStatus} (must be UNDER_REVIEW)`,
      );
    }

    return this.repository.update(id, {
      lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
      retirementNotes: notes ?? null,
    });
  }

  async retire(id: string, dto: RetireCatalogueItemDto): Promise<CatalogueItemWithDetails> {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (item.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
      throw new BadRequestException(
        `Cannot retire: current status is ${item.lifecycleStatus} (must be PUBLISHED)`,
      );
    }

    if (dto.retirementReason === CatalogueRetirementReason.DUPLICATE_CONSOLIDATION) {
      if (!dto.consolidatedIntoId) {
        throw new BadRequestException(
          'DUPLICATE_CONSOLIDATION requires a surviving consolidatedIntoId',
        );
      }
      if (dto.consolidatedIntoId === id) {
        throw new BadRequestException('Item cannot be consolidated into itself');
      }
      const target = await this.repository.findById(dto.consolidatedIntoId);
      if (!target) {
        throw new NotFoundException('Consolidation target catalogue item not found');
      }
      if (target.lifecycleStatus === CatalogueLifecycleStatus.RETIRED) {
        throw new BadRequestException(
          'Cannot consolidate into an already RETIRED catalogue item',
        );
      }
      if (target.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
        throw new BadRequestException(
          `Consolidation target must be PUBLISHED; current status is ${target.lifecycleStatus}`,
        );
      }
      if (target.categoryId !== item.categoryId) {
        throw new BadRequestException(
          'Consolidation target must belong to the same Category',
        );
      }
      if (target.consolidatedIntoId) {
        throw new BadRequestException(
          'Consolidation target is already consolidated into another catalogue item; chaining consolidations is prohibited',
        );
      }

      // Cycle detection: verify target was not previously consolidated into source item
      const existingReverseConsolidation = await this.prisma.seafoodCatalogueItem.findFirst({
        where: { consolidatedIntoId: id, id: dto.consolidatedIntoId },
      });
      if (existingReverseConsolidation) {
        throw new BadRequestException(
          'Consolidation cycle detected: target item is already consolidated into this item',
        );
      }
    }

    return this.repository.update(id, {
      lifecycleStatus: CatalogueLifecycleStatus.RETIRED,
      retirementReason: dto.retirementReason,
      retirementNotes: dto.retirementNotes ?? null,
      consolidatedIntoId: dto.consolidatedIntoId ?? null,
    });
  }

  async findById(id: string, requirePublished = false): Promise<CatalogueItemWithDetails> {
    const item = await this.repository.findById(id);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    if (requirePublished && item.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
      throw new NotFoundException('Catalogue item not found');
    }

    return item;
  }

  async findMany(query: QueryCatalogueDto, requirePublished = true): Promise<{
    items: CatalogueItemWithDetails[];
    total: number;
    page: number;
    limit: number;
  }> {
    const skip = (query.page - 1) * query.limit;
    const filter = {
      categoryId: query.categoryId,
      search: query.search,
      compositionMode: query.compositionMode,
      lifecycleStatus: requirePublished
        ? CatalogueLifecycleStatus.PUBLISHED
        : query.lifecycleStatus,
      skip,
      take: query.limit,
    };

    const [items, total] = await Promise.all([
      this.repository.findMany(filter),
      this.repository.count(filter),
    ]);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async requestRegulatoryOverride(
    requesterUserId: string,
    dto: CreateRegulatoryOverrideDto,
  ) {
    if (dto.expiresAt <= new Date()) {
      throw new BadRequestException('Override expiry must be in the future');
    }

    const item = await this.repository.findById(dto.catalogueItemId);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    // Check that none of the species is legally prohibited
    for (const link of item.speciesLinks) {
      if (link.species.regulatoryStatus === 'PROHIBITED') {
        throw new BadRequestException(
          `Cannot create override for legally PROHIBITED species ${link.species.commercialName}`,
        );
      }
    }

    return this.repository.createOverride({
      catalogueItemId: dto.catalogueItemId,
      requestedByUserId: requesterUserId,
      approvedByUserId: null,
      reason: dto.reason,
      justification: dto.justification,
      documentEvidenceUrl: dto.documentEvidenceUrl,
      expiresAt: dto.expiresAt,
    });
  }

  async approveRegulatoryOverride(
    overrideId: string,
    approverUserId: string,
  ) {
    const override = await this.repository.findOverrideById(overrideId);
    if (!override) {
      throw new NotFoundException('Regulatory override not found');
    }

    if (override.revokedAt) {
      throw new BadRequestException('Cannot approve a revoked regulatory override');
    }

    if (override.approvedByUserId) {
      throw new ConflictException('Regulatory override is already approved');
    }

    if (override.expiresAt <= new Date()) {
      throw new BadRequestException('Cannot approve an expired regulatory override');
    }

    if (override.requestedByUserId === approverUserId) {
      throw new BadRequestException(
        'Regulatory override requires two-party authorization; requester cannot approve their own override',
      );
    }

    const item = await this.repository.findById(override.catalogueItemId);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    for (const link of item.speciesLinks) {
      if (link.species.regulatoryStatus === 'PROHIBITED') {
        throw new BadRequestException(
          `Cannot approve override for legally PROHIBITED species ${link.species.commercialName}`,
        );
      }
    }

    return this.repository.approveOverride(overrideId, approverUserId);
  }

  async createRegulatoryOverride(
    requesterUserId: string,
    dto: CreateRegulatoryOverrideDto,
    approverUserId: string,
  ) {
    if (requesterUserId === approverUserId) {
      throw new BadRequestException(
        'Regulatory override requires two-party authorization; requester cannot be approver',
      );
    }

    if (dto.expiresAt <= new Date()) {
      throw new BadRequestException('Override expiry must be in the future');
    }

    const item = await this.repository.findById(dto.catalogueItemId);
    if (!item) {
      throw new NotFoundException('Catalogue item not found');
    }

    // Check that none of the species is legally prohibited
    for (const link of item.speciesLinks) {
      if (link.species.regulatoryStatus === 'PROHIBITED') {
        throw new BadRequestException(
          `Cannot create override for legally PROHIBITED species ${link.species.commercialName}`,
        );
      }
    }

    return this.repository.createOverride({
      catalogueItemId: dto.catalogueItemId,
      requestedByUserId: requesterUserId,
      approvedByUserId: approverUserId,
      reason: dto.reason,
      justification: dto.justification,
      documentEvidenceUrl: dto.documentEvidenceUrl,
      expiresAt: dto.expiresAt,
    });
  }

  private async validateComposition(
    mode: CatalogueCompositionMode,
    species?: LinkSpeciesDto[],
  ): Promise<void> {
    const count = species?.length ?? 0;

    switch (mode) {
      case CatalogueCompositionMode.SINGLE_SPECIES:
        if (count !== 1) {
          throw new BadRequestException(
            `SINGLE_SPECIES composition requires exactly 1 species; received ${count}`,
          );
        }
        break;

      case CatalogueCompositionMode.FIXED_COMPOSITE:
        if (count < 2) {
          throw new BadRequestException(
            `FIXED_COMPOSITE composition requires at least 2 species; received ${count}`,
          );
        }
        break;

      case CatalogueCompositionMode.UNVERIFIED_COMPOSITION:
        if (count > 0) {
          throw new BadRequestException(
            'UNVERIFIED_COMPOSITION items cannot have linked species without formal classification',
          );
        }
        break;

      case CatalogueCompositionMode.VARIABLE_COMPOSITE:
        // 0 or more typical species allowed
        break;
    }

    if (species && species.length > 0) {
      const speciesIds = species.map((s) => s.speciesId);
      const uniqueIds = new Set(speciesIds);
      if (uniqueIds.size !== speciesIds.length) {
        throw new BadRequestException('Duplicate species IDs supplied in composition links');
      }

      const existingSpecies = await this.prisma.species.findMany({
        where: { id: { in: speciesIds } },
        select: { id: true },
      });

      if (existingSpecies.length !== speciesIds.length) {
        throw new BadRequestException('One or more supplied species IDs do not exist');
      }
    }
  }
}
