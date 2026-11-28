import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CataloguePhoto,
  CataloguePhotoApprovalStatus,
  CataloguePhotoAuditAction,
  Prisma,
  Species,
  User,
} from '@prisma/client';

import { isAdministratorRole } from '../../../common/auth/admin-roles';
import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import {
  ApproveCataloguePhotoDto,
  BulkSwitchListingPhotosDto,
  QueryAdminCataloguePhotosDto,
  RejectCataloguePhotoDto,
  ReplaceCataloguePhotoDto,
  RetireCataloguePhotoDto,
  UpdateCataloguePhotoMetadataDto,
  UploadCataloguePhotoDto,
} from '../dto/admin-catalogue-photo.dto';
import { CataloguePhotoStorageService } from './catalogue-photo-storage.service';
import { validateCatalogueImageFile } from '../utils/image-validation.util';

const ACTOR_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
} as const;

const ADMIN_PHOTO_INCLUDE = {
  species: true,
  uploadedByUser: { select: ACTOR_SELECT },
  publishedByUser: { select: ACTOR_SELECT },
  rejectedByUser: { select: ACTOR_SELECT },
  retiredByUser: { select: ACTOR_SELECT },
  _count: { select: { products: true } },
} as const;

type AdminPhotoRow = CataloguePhoto & {
  species: Species;
  uploadedByUser: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  publishedByUser: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  rejectedByUser: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  retiredByUser: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  _count: { products: number };
};

export interface SerializedAdminCataloguePhoto {
  id: string;
  speciesId: string;
  catalogueItemId: string | null;
  versionGroupId: string;
  versionNumber: number;
  replacesPhotoId: string | null;
  isDefault: boolean;
  title: string;
  scientificName: string;
  jamaicanAliases: string[];
  imageUrl: string;
  lifecycleStatus: 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETIRED';
  approvalStatus: CataloguePhotoApprovalStatus;
  storageProvider: string;
  storageContainer: string | null;
  storageKey: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sourceName: string;
  sourceUrl: string;
  photographer: string;
  licenseName: string;
  licenseUrl: string;
  modifications: string;
  requiresAttribution: boolean;
  publishedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  retiredAt: string | null;
  retirementReason: string | null;
  createdAt: string;
  updatedAt: string;
  usageCount: number;
  species: {
    id: string;
    commercialName: string;
    scientificName: string;
    regulatoryStatus: string;
  };
  uploadedBy: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  publishedBy: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  rejectedBy: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
  retiredBy: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null;
}

@Injectable()
export class AdminCataloguePhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CataloguePhotoStorageService,
  ) {}

  static deriveLifecycleStatus(
    photo: Pick<CataloguePhoto, 'approvalStatus' | 'retiredAt'>,
  ): 'DRAFT' | 'APPROVED' | 'REJECTED' | 'RETIRED' {
    if (photo.retiredAt) {
      return 'RETIRED';
    }
    if (photo.approvalStatus === CataloguePhotoApprovalStatus.PENDING) {
      return 'DRAFT';
    }
    return photo.approvalStatus;
  }

  static serialize(row: AdminPhotoRow): SerializedAdminCataloguePhoto {
    return {
      id: row.id,
      speciesId: row.speciesId,
      catalogueItemId: row.catalogueItemId,
      versionGroupId: row.versionGroupId,
      versionNumber: row.versionNumber,
      replacesPhotoId: row.replacesPhotoId,
      isDefault: row.isDefault,
      title: row.title,
      scientificName: row.scientificName,
      jamaicanAliases: row.jamaicanAliases,
      imageUrl: row.imageUrl,
      lifecycleStatus: AdminCataloguePhotosService.deriveLifecycleStatus(row),
      approvalStatus: row.approvalStatus,
      storageProvider: row.storageProvider,
      storageContainer: row.storageContainer,
      storageKey: row.storageKey,
      mimeType: row.mimeType,
      fileSizeBytes: row.fileSizeBytes,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      sourceName: row.sourceName,
      sourceUrl: row.sourceUrl,
      photographer: row.photographer,
      licenseName: row.licenseName,
      licenseUrl: row.licenseUrl,
      modifications: row.modifications,
      requiresAttribution: row.requiresAttribution,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      rejectionReason: row.rejectionReason,
      retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
      retirementReason: row.retirementReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      usageCount: row._count.products,
      species: {
        id: row.species.id,
        commercialName: row.species.commercialName,
        scientificName: row.species.scientificName,
        regulatoryStatus: row.species.regulatoryStatus,
      },
      uploadedBy: row.uploadedByUser,
      publishedBy: row.publishedByUser,
      rejectedBy: row.rejectedByUser,
      retiredBy: row.retiredByUser,
    };
  }

  async list(query: QueryAdminCataloguePhotosDto) {
    const where: Prisma.CataloguePhotoWhereInput = {
      ...(query.speciesId ? { speciesId: query.speciesId } : {}),
    };

    if (query.status === 'DRAFT') {
      where.approvalStatus = CataloguePhotoApprovalStatus.PENDING;
      where.retiredAt = null;
    } else if (query.status === 'APPROVED') {
      where.approvalStatus = CataloguePhotoApprovalStatus.APPROVED;
      where.retiredAt = null;
    } else if (query.status === 'REJECTED') {
      where.approvalStatus = CataloguePhotoApprovalStatus.REJECTED;
      where.retiredAt = null;
    } else if (query.status === 'RETIRED') {
      where.retiredAt = { not: null };
    }

    const [rows, species] = await Promise.all([
      this.prisma.cataloguePhoto.findMany({
        where,
        include: ADMIN_PHOTO_INCLUDE,
        orderBy: [
          { species: { commercialName: 'asc' } },
          { isDefault: 'desc' },
          { versionNumber: 'desc' },
          { createdAt: 'desc' },
        ],
      }),
      this.prisma.species.findMany({
        orderBy: { commercialName: 'asc' },
      }),
    ]);

    const term = query.search?.trim().toLowerCase();
    const filtered = term
      ? rows.filter((row) =>
          [
            row.title,
            row.scientificName,
            row.photographer,
            row.species.commercialName,
            row.species.scientificName,
            ...row.jamaicanAliases,
          ].some((v) => v.toLowerCase().includes(term)),
        )
      : rows;

    return {
      items: filtered.map((row) => AdminCataloguePhotosService.serialize(row)),
      species,
      storageConfigured: this.storage.isConfigured(),
    };
  }

  async getHistory(id: string) {
    const target = await this.prisma.cataloguePhoto.findUnique({
      where: { id },
      include: ADMIN_PHOTO_INCLUDE,
    });
    if (!target) {
      throw new NotFoundException('Catalogue photo not found');
    }

    const [versions, auditLogs] = await Promise.all([
      this.prisma.cataloguePhoto.findMany({
        where: { versionGroupId: target.versionGroupId },
        include: ADMIN_PHOTO_INCLUDE,
        orderBy: [{ versionNumber: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.cataloguePhotoAuditLog.findMany({
        where: { versionGroupId: target.versionGroupId },
        include: { actorUser: { select: ACTOR_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const versionIds = versions.map((v) => v.id);
    const linkedProducts =
      versionIds.length > 0 && typeof this.prisma.product?.findMany === 'function'
        ? await this.prisma.product.findMany({
            where: { cataloguePhotoId: { in: versionIds } },
            select: {
              id: true,
              name: true,
              vendorId: true,
              isActive: true,
              cataloguePhotoId: true,
              vendor: { select: { businessName: true } },
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
          })
        : [];

    const versionListings: Record<
      string,
      Array<{ id: string; name: string; vendorId: string; vendorName: string; isActive: boolean }>
    > = {};
    for (const product of linkedProducts) {
      if (!product.cataloguePhotoId) continue;
      const bucket = versionListings[product.cataloguePhotoId] ?? [];
      bucket.push({
        id: product.id,
        name: product.name,
        vendorId: product.vendorId,
        vendorName: product.vendor.businessName,
        isActive: product.isActive,
      });
      versionListings[product.cataloguePhotoId] = bucket;
    }

    return {
      photo: AdminCataloguePhotosService.serialize(target),
      versions: versions.map((v) => AdminCataloguePhotosService.serialize(v)),
      versionListings,
      auditLogs: auditLogs.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
        details: (entry.details as Record<string, unknown> | null) ?? null,
      })),
    };
  }

  async getProtectedImageBuffer(
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string; isPrivateDraft: boolean }> {
    const photo = await this.prisma.cataloguePhoto.findUnique({ where: { id } });
    if (!photo) {
      throw new NotFoundException('Catalogue photo not found');
    }

    if (photo.storageProvider === 'AZURE_BLOB' && photo.storageContainer && photo.storageKey) {
      const buffer = await this.storage.downloadBlobBuffer(photo.storageContainer, photo.storageKey);
      return {
        buffer,
        mimeType: photo.mimeType || 'image/png',
        isPrivateDraft: photo.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED,
      };
    }

    const localAsset = this.readBundledPublicImage(photo);
    if (localAsset) {
      return localAsset;
    }

    throw new NotFoundException('Catalogue photo binary is unavailable');
  }

  async uploadDraft(
    actor: RequestUser,
    file: Express.Multer.File | undefined,
    dto: UploadCataloguePhotoDto,
  ): Promise<SerializedAdminCataloguePhoto> {
    if (!file) {
      throw new BadRequestException('Image file is required.');
    }
    const validated = validateCatalogueImageFile(file);

    const species = await this.prisma.species.findUnique({ where: { id: dto.speciesId } });
    if (!species) {
      throw new BadRequestException('Selected species does not exist');
    }

    const catalogueItemId = await this.resolveCatalogueItemId(dto.speciesId, dto.catalogueItemId);
    const photoId = randomUUID();
    const uploaded = await this.storage.uploadPrivateDraft({
      speciesName: species.commercialName,
      photoId,
      versionNumber: 1,
      extension: validated.extension,
      mimeType: validated.mimeType,
      buffer: file.buffer,
    });

    const aliases = this.normalizeAliases(dto.jamaicanAliases, species.commercialName);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cataloguePhoto.create({
        data: {
          id: photoId,
          speciesId: species.id,
          catalogueItemId,
          versionGroupId: photoId,
          versionNumber: 1,
          isDefault: false,
          title: dto.title.trim(),
          scientificName: species.scientificName,
          jamaicanAliases: aliases,
          imageUrl: `/api/v1/admin/catalogue-photos/${photoId}/image`,
          storageProvider: 'AZURE_BLOB',
          storageContainer: uploaded.storageContainer,
          storageKey: uploaded.storageKey,
          mimeType: validated.mimeType,
          fileSizeBytes: validated.fileSizeBytes,
          widthPx: validated.widthPx,
          heightPx: validated.heightPx,
          sourceName: dto.sourceName.trim(),
          sourceUrl: dto.sourceUrl?.trim() || 'https://iriefishmongers.com/internal-asset',
          photographer: dto.photographer.trim(),
          licenseName: dto.licenseName.trim(),
          licenseUrl: dto.licenseUrl?.trim() || 'https://iriefishmongers.com/photo-credits',
          modifications: dto.modifications.trim(),
          requiresAttribution: dto.requiresAttribution ?? true,
          approvalStatus: CataloguePhotoApprovalStatus.PENDING,
          uploadedByUserId: actor.id,
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.UPLOAD_DRAFT,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: {
            versionNumber: 1,
            storageContainer: uploaded.storageContainer,
            storageKey: uploaded.storageKey,
            dimensions: `${validated.widthPx}x${validated.heightPx}`,
            mimeType: validated.mimeType,
          },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(created);
  }

  async updateMetadata(
    actor: RequestUser,
    id: string,
    dto: UpdateCataloguePhotoMetadataDto,
    file?: Express.Multer.File,
  ): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({
      where: { id },
      include: { species: true },
    });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (existing.retiredAt) {
      throw new BadRequestException('Cannot edit a retired photo; restore or create a replacement version.');
    }

    let nextStoragePatch: Prisma.CataloguePhotoUpdateInput = {};
    if (file) {
      if (existing.approvalStatus === CataloguePhotoApprovalStatus.APPROVED) {
        throw new BadRequestException(
          'Published photos cannot mutate their image in place; upload a replacement version instead.',
        );
      }
      const validated = validateCatalogueImageFile(file);
      const uploaded = await this.storage.uploadPrivateDraft({
        speciesName: existing.species.commercialName,
        photoId: existing.id,
        versionNumber: existing.versionNumber,
        extension: validated.extension,
        mimeType: validated.mimeType,
        buffer: file.buffer,
      });
      nextStoragePatch = {
        storageProvider: 'AZURE_BLOB',
        storageContainer: uploaded.storageContainer,
        storageKey: uploaded.storageKey,
        mimeType: validated.mimeType,
        fileSizeBytes: validated.fileSizeBytes,
        widthPx: validated.widthPx,
        heightPx: validated.heightPx,
        imageUrl: `/api/v1/admin/catalogue-photos/${existing.id}/image`,
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.jamaicanAliases !== undefined ? { jamaicanAliases: dto.jamaicanAliases } : {}),
          ...(dto.photographer !== undefined ? { photographer: dto.photographer.trim() } : {}),
          ...(dto.sourceName !== undefined ? { sourceName: dto.sourceName.trim() } : {}),
          ...(dto.sourceUrl !== undefined ? { sourceUrl: dto.sourceUrl.trim() } : {}),
          ...(dto.licenseName !== undefined ? { licenseName: dto.licenseName.trim() } : {}),
          ...(dto.licenseUrl !== undefined ? { licenseUrl: dto.licenseUrl.trim() } : {}),
          ...(dto.modifications !== undefined ? { modifications: dto.modifications.trim() } : {}),
          ...(dto.requiresAttribution !== undefined
            ? { requiresAttribution: dto.requiresAttribution }
            : {}),
          ...nextStoragePatch,
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.UPDATE_METADATA,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: {
            fieldsUpdated: Object.keys(dto).filter(
              (k) => (dto as Record<string, unknown>)[k] !== undefined,
            ),
            replacedDraftImage: Boolean(file),
          },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async replacePhoto(
    actor: RequestUser,
    oldId: string,
    file: Express.Multer.File | undefined,
    dto: ReplaceCataloguePhotoDto,
  ) {
    if (!file) {
      throw new BadRequestException('A new replacement image file is required.');
    }
    const validated = validateCatalogueImageFile(file);

    const publishDirectly = Boolean(dto.publishImmediately);
    if (publishDirectly && !isAdministratorRole(actor.roles)) {
      throw new ForbiddenException(
        'Only active administrators may publish a replacement directly; submit without publishImmediately to create a private draft version.',
      );
    }

    const oldPhoto = await this.prisma.cataloguePhoto.findUnique({
      where: { id: oldId },
      include: {
        species: true,
        _count: { select: { products: true } },
      },
    });
    if (!oldPhoto) {
      throw new NotFoundException('Source catalogue photo not found');
    }

    const maxVersionAgg = await this.prisma.cataloguePhoto.aggregate({
      where: { versionGroupId: oldPhoto.versionGroupId },
      _max: { versionNumber: true },
    });
    const nextVersionNumber = (maxVersionAgg._max.versionNumber ?? oldPhoto.versionNumber) + 1;
    const newPhotoId = randomUUID();

    const stored = publishDirectly
      ? await this.storage.uploadPublishedVersion({
          speciesName: oldPhoto.species.commercialName,
          versionGroupId: oldPhoto.versionGroupId,
          versionNumber: nextVersionNumber,
          extension: validated.extension,
          mimeType: validated.mimeType,
          buffer: file.buffer,
        })
      : await this.storage.uploadPrivateDraft({
          speciesName: oldPhoto.species.commercialName,
          photoId: newPhotoId,
          versionNumber: nextVersionNumber,
          extension: validated.extension,
          mimeType: validated.mimeType,
          buffer: file.buffer,
        });

    const newImageUrl = publishDirectly
      ? stored.publicUrl!
      : `/api/v1/admin/catalogue-photos/${newPhotoId}/image`;

    const created = await this.prisma.$transaction(async (tx) => {
      const makeDefault = publishDirectly && Boolean(dto.setAsDefault);
      if (makeDefault) {
        await tx.cataloguePhoto.updateMany({
          where: {
            speciesId: oldPhoto.speciesId,
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }

      const row = await tx.cataloguePhoto.create({
        data: {
          id: newPhotoId,
          speciesId: oldPhoto.speciesId,
          catalogueItemId: oldPhoto.catalogueItemId,
          versionGroupId: oldPhoto.versionGroupId,
          versionNumber: nextVersionNumber,
          replacesPhotoId: oldPhoto.id,
          isDefault: makeDefault,
          title: dto.title?.trim() || oldPhoto.title,
          scientificName: oldPhoto.scientificName,
          jamaicanAliases: dto.jamaicanAliases ?? oldPhoto.jamaicanAliases,
          imageUrl: newImageUrl,
          storageProvider: 'AZURE_BLOB',
          storageContainer: stored.storageContainer,
          storageKey: stored.storageKey,
          mimeType: validated.mimeType,
          fileSizeBytes: validated.fileSizeBytes,
          widthPx: validated.widthPx,
          heightPx: validated.heightPx,
          sourceName: dto.sourceName?.trim() || oldPhoto.sourceName,
          sourceUrl: dto.sourceUrl?.trim() || oldPhoto.sourceUrl,
          photographer: dto.photographer?.trim() || oldPhoto.photographer,
          licenseName: dto.licenseName?.trim() || oldPhoto.licenseName,
          licenseUrl: dto.licenseUrl?.trim() || oldPhoto.licenseUrl,
          modifications: dto.modifications?.trim() || oldPhoto.modifications,
          requiresAttribution: dto.requiresAttribution ?? oldPhoto.requiresAttribution,
          approvalStatus: publishDirectly
            ? CataloguePhotoApprovalStatus.APPROVED
            : CataloguePhotoApprovalStatus.PENDING,
          uploadedByUserId: actor.id,
          ...(publishDirectly ? { publishedAt: new Date(), publishedByUserId: actor.id } : {}),
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.UPLOAD_REPLACEMENT_DRAFT,
          actorUserId: actor.id,
          actorEmail: actor.email,
          affectedCount: oldPhoto._count.products,
          details: {
            replacesPhotoId: oldPhoto.id,
            oldVersionNumber: oldPhoto.versionNumber,
            newVersionNumber: nextVersionNumber,
            storageContainer: stored.storageContainer,
            storageKey: stored.storageKey,
            existingListingsPreserved: true,
          },
        },
      });

      if (publishDirectly) {
        await tx.cataloguePhotoAuditLog.create({
          data: {
            cataloguePhotoId: row.id,
            versionGroupId: row.versionGroupId,
            action: CataloguePhotoAuditAction.APPROVE_AND_PUBLISH,
            actorUserId: actor.id,
            actorEmail: actor.email,
            affectedCount: 0,
            details: { storageKey: stored.storageKey, publicUrl: newImageUrl },
          },
        });
        if (makeDefault) {
          await tx.cataloguePhotoAuditLog.create({
            data: {
              cataloguePhotoId: row.id,
              versionGroupId: row.versionGroupId,
              action: CataloguePhotoAuditAction.SET_DEFAULT,
              actorUserId: actor.id,
              actorEmail: actor.email,
              details: { speciesId: oldPhoto.speciesId },
            },
          });
        }
      }

      return row;
    });

    return {
      photo: AdminCataloguePhotosService.serialize(created),
      replacedPhotoId: oldPhoto.id,
      oldVersionUsageCount: oldPhoto._count.products,
    };
  }

  async approveAndPublish(
    actor: RequestUser,
    id: string,
    dto: ApproveCataloguePhotoDto,
  ): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({
      where: { id },
      include: { species: true },
    });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (existing.retiredAt) {
      throw new BadRequestException('Cannot approve a retired photo; use restore instead.');
    }

    let publicContainer = existing.storageContainer;
    let publicKey = existing.storageKey;
    let publicUrl = existing.imageUrl;

    if (
      existing.storageProvider === 'AZURE_BLOB' &&
      existing.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED
    ) {
      if (!existing.storageContainer || !existing.storageKey) {
        throw new ConflictException('Draft photo is missing its private storage key.');
      }
      const promoted = await this.storage.promotePrivateDraftToPublic({
        privateContainer: existing.storageContainer,
        privateStorageKey: existing.storageKey,
        speciesName: existing.species.commercialName,
        versionGroupId: existing.versionGroupId,
        versionNumber: existing.versionNumber,
        mimeType: existing.mimeType || 'image/png',
      });
      publicContainer = promoted.storageContainer;
      publicKey = promoted.storageKey;
      publicUrl = promoted.publicUrl;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const currentDefault = await tx.cataloguePhoto.findFirst({
        where: {
          speciesId: existing.speciesId,
          isDefault: true,
          retiredAt: null,
          approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
        },
        select: { id: true },
      });

      const shouldBeDefault = dto.setAsDefault === true || (!currentDefault && dto.setAsDefault !== false);
      if (shouldBeDefault && currentDefault && currentDefault.id !== existing.id) {
        await tx.cataloguePhoto.update({
          where: { id: currentDefault.id },
          data: { isDefault: false },
        });
      }

      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: {
          approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
          storageContainer: publicContainer,
          storageKey: publicKey,
          imageUrl: publicUrl,
          isDefault: shouldBeDefault || existing.isDefault,
          publishedAt: existing.publishedAt ?? new Date(),
          publishedByUserId: existing.publishedByUserId ?? actor.id,
          rejectedAt: null,
          rejectedByUserId: null,
          rejectionReason: null,
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.APPROVE_AND_PUBLISH,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: {
            previousStatus: existing.approvalStatus,
            storageContainer: publicContainer,
            storageKey: publicKey,
            publicUrl,
          },
        },
      });

      if (shouldBeDefault && currentDefault?.id !== row.id) {
        await tx.cataloguePhotoAuditLog.create({
          data: {
            cataloguePhotoId: row.id,
            versionGroupId: row.versionGroupId,
            action: CataloguePhotoAuditAction.SET_DEFAULT,
            actorUserId: actor.id,
            actorEmail: actor.email,
            details: {
              speciesId: existing.speciesId,
              previousDefaultId: currentDefault?.id ?? null,
            },
          },
        });
      }

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async rejectDraft(
    actor: RequestUser,
    id: string,
    dto: RejectCataloguePhotoDto,
  ): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (existing.approvalStatus === CataloguePhotoApprovalStatus.APPROVED && !existing.retiredAt) {
      throw new BadRequestException('Cannot reject an already published photo; retire it instead.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: {
          approvalStatus: CataloguePhotoApprovalStatus.REJECTED,
          rejectedAt: new Date(),
          rejectedByUserId: actor.id,
          rejectionReason: dto.reason?.trim() || 'Rejected by administrator',
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.REJECT_DRAFT,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: { reason: row.rejectionReason },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async setDefault(actor: RequestUser, id: string): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (existing.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED || existing.retiredAt) {
      throw new BadRequestException('Only active approved catalogue photos can be set as default.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const previousDefault = await tx.cataloguePhoto.findFirst({
        where: {
          speciesId: existing.speciesId,
          isDefault: true,
          id: { not: id },
        },
        select: { id: true },
      });

      if (previousDefault) {
        await tx.cataloguePhoto.updateMany({
          where: { speciesId: existing.speciesId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: { isDefault: true },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.SET_DEFAULT,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: {
            speciesId: existing.speciesId,
            previousDefaultId: previousDefault?.id ?? null,
          },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async retire(
    actor: RequestUser,
    id: string,
    dto: RetireCataloguePhotoDto,
  ): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (existing.retiredAt) {
      throw new BadRequestException('This catalogue photo is already retired.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: {
          retiredAt: new Date(),
          retiredByUserId: actor.id,
          retirementReason: dto.reason?.trim() || 'Retired from new vendor selections',
          isDefault: false,
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.RETIRE,
          actorUserId: actor.id,
          actorEmail: actor.email,
          affectedCount: existing._count.products,
          details: {
            reason: row.retirementReason,
            retainedForExistingListingsCount: existing._count.products,
          },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async restore(actor: RequestUser, id: string): Promise<SerializedAdminCataloguePhoto> {
    const existing = await this.prisma.cataloguePhoto.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Catalogue photo not found');
    }
    if (!existing.retiredAt) {
      throw new BadRequestException('Only retired catalogue photos can be restored.');
    }
    if (existing.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED) {
      throw new BadRequestException('Cannot restore an unapproved draft photo to live selections.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cataloguePhoto.update({
        where: { id },
        data: {
          retiredAt: null,
          retiredByUserId: null,
          retirementReason: null,
        },
        include: ADMIN_PHOTO_INCLUDE,
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: row.id,
          versionGroupId: row.versionGroupId,
          action: CataloguePhotoAuditAction.ROLLBACK_RESTORE,
          actorUserId: actor.id,
          actorEmail: actor.email,
          details: { restoredVersionNumber: row.versionNumber },
        },
      });

      return row;
    });

    return AdminCataloguePhotosService.serialize(updated);
  }

  async bulkSwitchListings(
    actor: RequestUser,
    toPhotoId: string,
    dto: BulkSwitchListingPhotosDto,
  ) {
    if (dto.confirmBulkSwitch !== true) {
      throw new BadRequestException(
        'Explicit confirmation (confirmBulkSwitch=true) is required to overwrite existing product listings.',
      );
    }
    if (dto.fromPhotoId === toPhotoId) {
      throw new BadRequestException('Source and replacement photo IDs must differ.');
    }

    const [fromPhoto, toPhoto] = await Promise.all([
      this.prisma.cataloguePhoto.findUnique({ where: { id: dto.fromPhotoId } }),
      this.prisma.cataloguePhoto.findUnique({ where: { id: toPhotoId } }),
    ]);

    if (!fromPhoto) {
      throw new NotFoundException('Source catalogue photo version not found');
    }
    if (!toPhoto) {
      throw new NotFoundException('Target replacement catalogue photo not found');
    }
    if (toPhoto.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED || toPhoto.retiredAt) {
      throw new BadRequestException('Target replacement photo must be approved and active.');
    }
    if (fromPhoto.speciesId !== toPhoto.speciesId) {
      throw new BadRequestException('Source and replacement photos must belong to the same species.');
    }

    const requestedProductIds = dto.productIds
      ? Array.from(new Set(dto.productIds.map((item) => item.trim()).filter(Boolean)))
      : null;
    if (requestedProductIds !== null && requestedProductIds.length === 0) {
      throw new BadRequestException(
        'Select at least one listing when specifying productIds for bulk switch.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const targetListings =
        typeof tx.product?.findMany === 'function'
          ? await tx.product.findMany({
              where: {
                cataloguePhotoId: fromPhoto.id,
                ...(requestedProductIds ? { id: { in: requestedProductIds } } : {}),
              },
              select: { id: true, name: true, vendorId: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
            })
          : [];

      if (requestedProductIds && targetListings.length !== requestedProductIds.length) {
        const matched = new Set(targetListings.map((item) => item.id));
        const missingIds = requestedProductIds.filter((productId) => !matched.has(productId));
        throw new BadRequestException(
          `Selected listing(s) do not reference the source catalogue photo version: ${missingIds.join(', ')}`,
        );
      }

      const affectedProductIds =
        targetListings.length > 0
          ? targetListings.map((item) => item.id)
          : requestedProductIds ?? [];
      const res = await tx.product.updateMany({
        where: {
          cataloguePhotoId: fromPhoto.id,
          ...(requestedProductIds ? { id: { in: requestedProductIds } } : {}),
        },
        data: {
          cataloguePhotoId: toPhoto.id,
          imageUrl: toPhoto.imageUrl,
        },
      });

      await tx.cataloguePhotoAuditLog.create({
        data: {
          cataloguePhotoId: toPhoto.id,
          versionGroupId: toPhoto.versionGroupId,
          action: CataloguePhotoAuditAction.BULK_SWITCH_LISTINGS,
          actorUserId: actor.id,
          actorEmail: actor.email,
          affectedCount: res.count,
          details: {
            fromPhotoId: fromPhoto.id,
            fromVersionNumber: fromPhoto.versionNumber,
            toPhotoId: toPhoto.id,
            toVersionNumber: toPhoto.versionNumber,
            selectionMode: requestedProductIds ? 'SELECTED_LISTINGS' : 'ALL_SOURCE_LISTINGS',
            affectedProductIds,
            affectedListings: targetListings.map((item) => ({
              id: item.id,
              name: item.name,
              vendorId: item.vendorId,
            })),
          },
        },
      });

      return {
        switchedCount: res.count,
        affectedProductIds,
      };
    });

    return {
      fromPhotoId: fromPhoto.id,
      toPhotoId: toPhoto.id,
      switchedCount: result.switchedCount,
      affectedProductIds: result.affectedProductIds,
    };
  }

  private async resolveCatalogueItemId(
    speciesId: string,
    requestedCatalogueItemId?: string,
  ): Promise<string | null> {
    if (requestedCatalogueItemId) {
      const item = await this.prisma.seafoodCatalogueItem.findUnique({
        where: { id: requestedCatalogueItemId },
        select: { id: true },
      });
      if (!item) {
        throw new BadRequestException('Specified catalogueItemId does not exist');
      }
      return item.id;
    }

    const link = await this.prisma.catalogueItemSpecies.findFirst({
      where: {
        speciesId,
        isPrimary: true,
      },
      select: { catalogueItemId: true },
    });
    return link?.catalogueItemId ?? null;
  }

  private normalizeAliases(aliases: string[] | undefined, fallbackCommercialName: string): string[] {
    const cleaned = (aliases ?? []).map((a) => a.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      return Array.from(new Set(cleaned));
    }
    return [fallbackCommercialName];
  }

  private readBundledPublicImage(
    photo: Pick<CataloguePhoto, 'imageUrl' | 'mimeType' | 'approvalStatus'>,
  ): { buffer: Buffer; mimeType: string; isPrivateDraft: boolean } | null {
    if (!photo.imageUrl.startsWith('/')) {
      return null;
    }

    const relativePath = photo.imageUrl.replace(/^\/+/, '');
    if (!relativePath) {
      return null;
    }

    const publicRoots = Array.from(
      new Set([
        path.resolve(process.cwd(), '../apps/web/public'),
        path.resolve(process.cwd(), 'apps/web/public'),
        path.resolve(__dirname, '../../../../../apps/web/public'),
        path.resolve(__dirname, '../../../../apps/web/public'),
      ]),
    );

    const extMimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.png': 'image/png',
    };

    for (const publicRoot of publicRoots) {
      const candidate = path.resolve(publicRoot, relativePath);
      if (!candidate.startsWith(`${publicRoot}${path.sep}`)) {
        continue;
      }
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        return {
          buffer: fs.readFileSync(candidate),
          mimeType: photo.mimeType || extMimeTypes[ext] || 'image/png',
          isPrivateDraft: photo.approvalStatus !== CataloguePhotoApprovalStatus.APPROVED,
        };
      }
    }

    return null;
  }
}
