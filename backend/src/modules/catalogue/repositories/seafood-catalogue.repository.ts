import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CatalogueCompositionMode,
  CatalogueLifecycleStatus,
  CataloguePhotoApprovalStatus,
  CatalogueRetirementReason,
  Prisma,
  ProductUnit,
  RegulatoryOverrideReason,
  RegulatoryStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { LinkSpeciesDto } from '../dto/link-species.dto';

export const catalogueItemWithDetails = Prisma.validator<Prisma.SeafoodCatalogueItemDefaultArgs>()({
  include: {
    category: true,
    speciesLinks: {
      include: {
        species: true,
      },
      orderBy: {
        isPrimary: 'desc',
      },
    },
    regulatoryOverrides: {
      where: {
        revokedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    },
    consolidatedInto: true,
  },
});

export type CatalogueItemWithDetails = Prisma.SeafoodCatalogueItemGetPayload<typeof catalogueItemWithDetails>;

export interface CreateCatalogueItemInput {
  name: string;
  scientificName?: string;
  scientificFamily?: string;
  commonName: string;
  jamaicanNames?: string[];
  description?: string;
  categoryId: string;
  compositionMode: CatalogueCompositionMode;
  referenceImageUrl?: string;
  imageSourceLicense?: string;
  typicalUnit?: ProductUnit;
  typicalSizeMinCm?: number;
  typicalSizeMaxCm?: number;
  typicalWeightMinLbs?: number;
  typicalWeightMaxLbs?: number;
}

export interface UpdateCatalogueItemInput {
  name?: string;
  scientificName?: string;
  scientificFamily?: string;
  commonName?: string;
  jamaicanNames?: string[];
  description?: string;
  categoryId?: string;
  compositionMode?: CatalogueCompositionMode;
  lifecycleStatus?: CatalogueLifecycleStatus;
  retirementReason?: CatalogueRetirementReason | null;
  retirementNotes?: string | null;
  consolidatedIntoId?: string | null;
  referenceImageUrl?: string;
  imageSourceLicense?: string;
  typicalUnit?: ProductUnit;
  typicalSizeMinCm?: number;
  typicalSizeMaxCm?: number;
  typicalWeightMinLbs?: number;
  typicalWeightMaxLbs?: number;
}

export interface CatalogueFilterInput {
  categoryId?: string;
  search?: string;
  compositionMode?: CatalogueCompositionMode;
  lifecycleStatus?: CatalogueLifecycleStatus;
  skip?: number;
  take?: number;
}

@Injectable()
export class SeafoodCatalogueRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<CatalogueItemWithDetails | null> {
    const client = tx || this.prisma;
    return client.seafoodCatalogueItem.findUnique({
      where: { id },
      include: catalogueItemWithDetails.include,
    });
  }

  async findByName(name: string): Promise<CatalogueItemWithDetails | null> {
    return this.prisma.seafoodCatalogueItem.findFirst({
      where: {
        name: {
          equals: name.trim(),
          mode: 'insensitive',
        },
      },
      include: catalogueItemWithDetails.include,
    });
  }

  async findMany(filters: CatalogueFilterInput): Promise<CatalogueItemWithDetails[]> {
    const where = this.buildWhereClause(filters);
    return this.prisma.seafoodCatalogueItem.findMany({
      where,
      include: catalogueItemWithDetails.include,
      orderBy: { name: 'asc' },
      skip: filters.skip ?? 0,
      take: filters.take ?? 20,
    });
  }

  async count(filters: CatalogueFilterInput): Promise<number> {
    const where = this.buildWhereClause(filters);
    return this.prisma.seafoodCatalogueItem.count({ where });
  }

  async create(
    data: CreateCatalogueItemInput,
    species?: LinkSpeciesDto[],
  ): Promise<CatalogueItemWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.seafoodCatalogueItem.create({
        data: {
          name: data.name.trim(),
          scientificName: data.scientificName?.trim() || null,
          scientificFamily: data.scientificFamily?.trim() || null,
          commonName: data.commonName.trim(),
          jamaicanNames: data.jamaicanNames ?? [],
          description: data.description?.trim() || null,
          categoryId: data.categoryId,
          compositionMode: data.compositionMode,
          lifecycleStatus: CatalogueLifecycleStatus.DRAFT,
          referenceImageUrl: data.referenceImageUrl || null,
          imageSourceLicense: data.imageSourceLicense?.trim() || null,
          typicalUnit: data.typicalUnit ?? ProductUnit.PER_POUND,
          typicalSizeMinCm: data.typicalSizeMinCm !== undefined ? new Prisma.Decimal(data.typicalSizeMinCm) : null,
          typicalSizeMaxCm: data.typicalSizeMaxCm !== undefined ? new Prisma.Decimal(data.typicalSizeMaxCm) : null,
          typicalWeightMinLbs: data.typicalWeightMinLbs !== undefined ? new Prisma.Decimal(data.typicalWeightMinLbs) : null,
          typicalWeightMaxLbs: data.typicalWeightMaxLbs !== undefined ? new Prisma.Decimal(data.typicalWeightMaxLbs) : null,
        },
      });

      if (species && species.length > 0) {
        await tx.catalogueItemSpecies.createMany({
          data: species.map((s) => ({
            catalogueItemId: created.id,
            speciesId: s.speciesId,
            isPrimary: s.isPrimary ?? false,
            typicalProportion: s.typicalProportion !== undefined ? new Prisma.Decimal(s.typicalProportion) : null,
          })),
        });
      }

      return tx.seafoodCatalogueItem.findUniqueOrThrow({
        where: { id: created.id },
        include: catalogueItemWithDetails.include,
      });
    });
  }

  async update(
    id: string,
    data: UpdateCatalogueItemInput,
    species?: LinkSpeciesDto[],
  ): Promise<CatalogueItemWithDetails> {
    return this.prisma.$transaction(async (tx) => {
      // Deterministic lock ordering: lock source item, and if consolidating, also lock target in sorted order
      const idsToLock = [id];
      if (data.consolidatedIntoId) {
        if (data.consolidatedIntoId === id) {
          throw new BadRequestException('Consolidation target cannot be self-referential.');
        }
        idsToLock.push(data.consolidatedIntoId);
      }
      idsToLock.sort();

      if (typeof (tx as any).$queryRaw === 'function') {
        for (const itemToLock of idsToLock) {
          await tx.$queryRaw`SELECT id FROM seafood_catalogue_items WHERE id = ${itemToLock} FOR UPDATE`;
        }
      }

      if (data.consolidatedIntoId) {

        // 2. Re-fetch locked target state
        const target = await tx.seafoodCatalogueItem.findUnique({
          where: { id: data.consolidatedIntoId },
          select: { id: true, lifecycleStatus: true, consolidatedIntoId: true },
        });
        if (!target) {
          throw new BadRequestException('Consolidation target not found.');
        }
        if (target.lifecycleStatus === CatalogueLifecycleStatus.RETIRED || target.lifecycleStatus !== CatalogueLifecycleStatus.PUBLISHED) {
          throw new BadRequestException(
            'Consolidation target must be in PUBLISHED status and not retired.',
          );
        }
        // 3. Cycle prevention
        if (target.consolidatedIntoId === id) {
          throw new BadRequestException(
            'Consolidation cycle detected: target item is already consolidated into this item.',
          );
        }
        const reverseLink = await tx.seafoodCatalogueItem.findFirst({
          where: {
            id: data.consolidatedIntoId,
            consolidatedIntoId: id,
          },
        });
        if (reverseLink) {
          throw new BadRequestException(
            'Consolidation cycle detected: target item is already consolidated into this item.',
          );
        }

        // 4. Multi-hop chaining prevention
        if (target.consolidatedIntoId !== null) {
          throw new BadRequestException(
            'Consolidation target must not be already consolidated into another item (chaining is prohibited).',
          );
        }
      }

      await tx.seafoodCatalogueItem.update({
        where: { id },
        data: {
          name: data.name !== undefined ? data.name.trim() : undefined,
          scientificName: data.scientificName !== undefined ? data.scientificName?.trim() || null : undefined,
          scientificFamily: data.scientificFamily !== undefined ? data.scientificFamily?.trim() || null : undefined,
          commonName: data.commonName !== undefined ? data.commonName.trim() : undefined,
          jamaicanNames: data.jamaicanNames !== undefined ? data.jamaicanNames : undefined,
          description: data.description !== undefined ? data.description?.trim() || null : undefined,
          categoryId: data.categoryId !== undefined ? data.categoryId : undefined,
          compositionMode: data.compositionMode !== undefined ? data.compositionMode : undefined,
          lifecycleStatus: data.lifecycleStatus !== undefined ? data.lifecycleStatus : undefined,
          retirementReason: data.retirementReason !== undefined ? data.retirementReason : undefined,
          retirementNotes: data.retirementNotes !== undefined ? data.retirementNotes : undefined,
          consolidatedIntoId: data.consolidatedIntoId !== undefined ? data.consolidatedIntoId : undefined,
          referenceImageUrl: data.referenceImageUrl !== undefined ? data.referenceImageUrl : undefined,
          imageSourceLicense: data.imageSourceLicense !== undefined ? data.imageSourceLicense?.trim() || null : undefined,
          typicalUnit: data.typicalUnit !== undefined ? data.typicalUnit : undefined,
          typicalSizeMinCm: data.typicalSizeMinCm !== undefined ? (data.typicalSizeMinCm !== null ? new Prisma.Decimal(data.typicalSizeMinCm) : null) : undefined,
          typicalSizeMaxCm: data.typicalSizeMaxCm !== undefined ? (data.typicalSizeMaxCm !== null ? new Prisma.Decimal(data.typicalSizeMaxCm) : null) : undefined,
          typicalWeightMinLbs: data.typicalWeightMinLbs !== undefined ? (data.typicalWeightMinLbs !== null ? new Prisma.Decimal(data.typicalWeightMinLbs) : null) : undefined,
          typicalWeightMaxLbs: data.typicalWeightMaxLbs !== undefined ? (data.typicalWeightMaxLbs !== null ? new Prisma.Decimal(data.typicalWeightMaxLbs) : null) : undefined,
        },
      });

      if (species !== undefined) {
        await tx.catalogueItemSpecies.deleteMany({
          where: { catalogueItemId: id },
        });

        if (species.length > 0) {
          await tx.catalogueItemSpecies.createMany({
            data: species.map((s) => ({
              catalogueItemId: id,
              speciesId: s.speciesId,
              isPrimary: s.isPrimary ?? false,
              typicalProportion: s.typicalProportion !== undefined ? new Prisma.Decimal(s.typicalProportion) : null,
            })),
          });
        }
      }

      return tx.seafoodCatalogueItem.findUniqueOrThrow({
        where: { id },
        include: catalogueItemWithDetails.include,
      });
    });
  }

  async createOverride(data: {
    catalogueItemId: string;
    requestedByUserId: string;
    approvedByUserId?: string | null;
    reason: RegulatoryOverrideReason;
    justification: string;
    documentEvidenceUrl?: string;
    expiresAt: Date;
  }) {
    return this.prisma.regulatoryOverride.create({
      data: {
        catalogueItemId: data.catalogueItemId,
        requestedByUserId: data.requestedByUserId,
        approvedByUserId: data.approvedByUserId ?? null,
        reason: data.reason,
        justification: data.justification,
        documentEvidenceUrl: data.documentEvidenceUrl || null,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findOverrideById(id: string) {
    return this.prisma.regulatoryOverride.findUnique({
      where: { id },
    });
  }

  async approveOverride(id: string, approverUserId: string) {
    return this.prisma.regulatoryOverride.update({
      where: { id },
      data: { approvedByUserId: approverUserId },
    });
  }

  async findActiveOverride(catalogueItemId: string, atDate: Date, tx?: Prisma.TransactionClient) {
    const client = tx || this.prisma;
    return client.regulatoryOverride.findFirst({
      where: {
        catalogueItemId,
        revokedAt: null,
        approvedByUserId: { not: null },
        expiresAt: {
          gt: atDate,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private buildWhereClause(filters: CatalogueFilterInput): Prisma.SeafoodCatalogueItemWhereInput {
    const where: Prisma.SeafoodCatalogueItemWhereInput = {};

    if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }

    if (filters.compositionMode) {
      where.compositionMode = filters.compositionMode;
    }

    if (filters.lifecycleStatus) {
      where.lifecycleStatus = filters.lifecycleStatus;
    }

    if (filters.search) {
      const term = filters.search.trim();
      const aliasVariants = Array.from(
        new Set([
          term,
          term.toLowerCase(),
          term.toUpperCase(),
          term.replace(/\b\w/g, (ch) => ch.toUpperCase()),
        ]),
      );
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { commonName: { contains: term, mode: 'insensitive' } },
        { scientificName: { contains: term, mode: 'insensitive' } },
        { jamaicanNames: { hasSome: aliasVariants } },
        {
          speciesLinks: {
            some: {
              species: {
                OR: [
                  { commercialName: { contains: term, mode: 'insensitive' } },
                  { scientificName: { contains: term, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ];
    }

    return where;
  }

  async findApprovedPhotos(filters: {
    speciesId?: string;
    search?: string;
    includeReferencedRetired?: boolean;
  }) {
    const photos = await this.prisma.cataloguePhoto.findMany({
      where: {
        approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
        ...(filters.includeReferencedRetired
          ? {
              OR: [
                { retiredAt: null },
                { products: { some: { isActive: true } } },
              ],
            }
          : { retiredAt: null }),
        ...(filters.speciesId ? { speciesId: filters.speciesId } : {}),
        species: {
          regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
        },
      },
      include: {
        species: true,
        catalogueItem: {
          select: {
            id: true,
            commonName: true,
            jamaicanNames: true,
            lifecycleStatus: true,
          },
        },
      },
      orderBy: [
        { isDefault: 'desc' },
        { species: { commercialName: 'asc' } },
        { versionNumber: 'desc' },
        { title: 'asc' },
      ],
    });

    const term = filters.search?.trim().toLowerCase();
    if (!term) {
      return photos;
    }

    return photos.filter((photo) => {
      const haystacks: string[] = [
        photo.title,
        photo.scientificName,
        photo.species.commercialName,
        photo.species.scientificName,
        ...photo.jamaicanAliases,
        ...(photo.catalogueItem?.jamaicanNames ?? []),
        photo.catalogueItem?.commonName ?? '',
      ];
      return haystacks.some((value) => value.toLowerCase().includes(term));
    });
  }
}
