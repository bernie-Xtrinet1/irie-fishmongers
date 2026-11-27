import { ForbiddenException, BadRequestException } from '@nestjs/common';
import {
  CataloguePhotoApprovalStatus,
  CataloguePhotoAuditAction,
  RegulatoryStatus,
  RoleName,
  UserStatus,
} from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CataloguePhotoAdminGuard } from '../guards/catalogue-photo-admin.guard';
import { CataloguePhotoManageGuard } from '../guards/catalogue-photo-manage.guard';
import { CataloguePhotoViewGuard } from '../guards/catalogue-photo-view.guard';
import { AdminCataloguePhotosService } from '../services/admin-catalogue-photos.service';
import { CataloguePhotoStorageService } from '../services/catalogue-photo-storage.service';

function makePngBuffer(width = 900, height = 600): Buffer {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

describe('AdminCataloguePhotosService & RBAC Guards', () => {
  const adminWithPerm: RequestUser = {
    id: 'admin-1',
    email: 'admin@test.local',
    roles: [RoleName.ADMINISTRATOR],
    canManageCataloguePhotos: true,
  };
  const staffWithPerm: RequestUser = {
    id: 'staff-1',
    email: 'editor@test.local',
    roles: [RoleName.OPERATIONS_STAFF],
    canManageCataloguePhotos: true,
  };

  describe('Permission Guards', () => {
    it('CataloguePhotoManageGuard requires explicit DB permission canManageCataloguePhotos=true', async () => {
      const prismaMock = {
        user: {
          findUnique: jest.fn(),
        },
      };
      const guard = new CataloguePhotoManageGuard(prismaMock as never);

      const makeCtx = (user: RequestUser) =>
        ({
          switchToHttp: () => ({ getRequest: () => ({ user }) }),
        }) as never;

      // ADMINISTRATOR without explicit permission -> 403 Forbidden
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'admin-no-perm',
        email: 'admin2@test.local',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: false,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });
      await expect(
        guard.canActivate(
          makeCtx({
            id: 'admin-no-perm',
            email: 'admin2@test.local',
            roles: [RoleName.ADMINISTRATOR],
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      // OPERATIONS_STAFF WITH explicit permission -> allowed for upload/edit
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'staff-1',
        email: 'editor@test.local',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: true,
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      });
      await expect(guard.canActivate(makeCtx(staffWithPerm))).resolves.toBe(true);

      // VENDOR even if flag forged -> 403 Forbidden
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'vendor-1',
        email: 'vendor@test.local',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: true,
        roles: [{ role: { name: RoleName.VENDOR } }],
      });
      await expect(
        guard.canActivate(
          makeCtx({ id: 'vendor-1', email: 'vendor@test.local', roles: [RoleName.VENDOR] }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('CataloguePhotoAdminGuard blocks permitted OPERATIONS_STAFF from publish/retire/bulk-switch', async () => {
      const prismaMock = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'staff-1',
            email: 'editor@test.local',
            status: UserStatus.ACTIVE,
            canManageCataloguePhotos: true,
            roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
          }),
        },
      };
      const guard = new CataloguePhotoAdminGuard(prismaMock as never);
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: staffWithPerm }) }),
      } as never;

      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('CataloguePhotoViewGuard denies unpermitted OPERATIONS_STAFF and allows permitted editor or active ADMIN', async () => {
      const prismaMock = {
        user: { findUnique: jest.fn() },
      };
      const guard = new CataloguePhotoViewGuard(prismaMock as never);
      const makeCtx = (user: RequestUser) =>
        ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'staff-no-perm',
        email: 'ops@test.local',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: false,
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      });
      await expect(
        guard.canActivate(
          makeCtx({
            id: 'staff-no-perm',
            email: 'ops@test.local',
            roles: [RoleName.OPERATIONS_STAFF],
          }),
        ),
      ).rejects.toThrow(ForbiddenException);

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'staff-1',
        email: 'editor@test.local',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: true,
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      });
      await expect(guard.canActivate(makeCtx(staffWithPerm))).resolves.toBe(true);
    });
  });

  describe('Upload, Approve/Publish, Replace, Bulk-Switch, and Retire Workflows', () => {
    function buildService() {
      const tilapiaSpecies = {
        id: 'sp-tilapia',
        commercialName: 'Tilapia',
        scientificName: 'Oreochromis niloticus',
        regulatoryStatus: RegulatoryStatus.UNRESTRICTED,
      };
      const storage = {
        isConfigured: jest.fn().mockReturnValue(true),
        publicContainerName: 'catalogue-photos',
        privateContainerName: 'catalogue-photos-drafts',
        uploadPrivateDraft: jest.fn().mockResolvedValue({
          storageContainer: 'catalogue-photos-drafts',
          storageKey: 'drafts/tilapia/photo-v1/v1-uuid.png',
        }),
        uploadPublishedVersion: jest.fn().mockResolvedValue({
          storageContainer: 'catalogue-photos',
          storageKey: 'published/tilapia/group-1/v2-uuid.png',
          publicUrl:
            'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v2-uuid.png',
        }),
        promotePrivateDraftToPublic: jest.fn().mockResolvedValue({
          storageContainer: 'catalogue-photos',
          storageKey: 'published/tilapia/group-1/v1-uuid.png',
          publicUrl:
            'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v1-uuid.png',
        }),
        downloadBlobBuffer: jest.fn(),
      } as unknown as jest.Mocked<CataloguePhotoStorageService>;

      const txMock = {
        cataloguePhoto: {
          create: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
        cataloguePhotoAuditLog: {
          create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        },
        product: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };

      const prisma = {
        species: { findUnique: jest.fn().mockResolvedValue(tilapiaSpecies), findMany: jest.fn() },
        catalogueItemSpecies: { findFirst: jest.fn().mockResolvedValue({ catalogueItemId: 'cat-1' }) },
        seafoodCatalogueItem: { findUnique: jest.fn() },
        cataloguePhoto: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
          aggregate: jest.fn().mockResolvedValue({ _max: { versionNumber: 1 } }),
        },
        cataloguePhotoAuditLog: { findMany: jest.fn() },
        $transaction: jest.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
      };

      const service = new AdminCataloguePhotosService(prisma as never, storage);
      return { service, prisma, txMock, storage, tilapiaSpecies };
    }

    it('stores uploaded draft privately, preserves private imageUrl, and logs UPLOAD_DRAFT', async () => {
      const { service, txMock, storage, tilapiaSpecies } = buildService();
      const now = new Date();
      txMock.cataloguePhoto.create.mockResolvedValue({
        id: 'photo-draft-1',
        speciesId: 'sp-tilapia',
        catalogueItemId: 'cat-1',
        versionGroupId: 'photo-draft-1',
        versionNumber: 1,
        replacesPhotoId: null,
        isDefault: false,
        title: 'Fresh Tilapia Side View',
        scientificName: 'Oreochromis niloticus',
        jamaicanAliases: ['Red Belly', 'Tilapia'],
        imageUrl: '/api/v1/admin/catalogue-photos/photo-draft-1/image',
        storageProvider: 'AZURE_BLOB',
        storageContainer: 'catalogue-photos-drafts',
        storageKey: 'drafts/tilapia/photo-v1/v1-uuid.png',
        mimeType: 'image/png',
        fileSizeBytes: 64,
        widthPx: 900,
        heightPx: 600,
        sourceName: 'Studio Upload',
        sourceUrl: 'https://iriefishmongers.com/internal-asset',
        photographer: 'Jane Photographer',
        licenseName: 'Company Owned',
        licenseUrl: 'https://iriefishmongers.com/photo-credits',
        modifications: 'Cropped 3:2',
        requiresAttribution: true,
        approvalStatus: CataloguePhotoApprovalStatus.PENDING,
        publishedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        retiredAt: null,
        retirementReason: null,
        createdAt: now,
        updatedAt: now,
        species: tilapiaSpecies,
        uploadedByUser: { id: staffWithPerm.id, email: staffWithPerm.email, firstName: 'Ops', lastName: 'Staff' },
        publishedByUser: null,
        rejectedByUser: null,
        retiredByUser: null,
        _count: { products: 0 },
      });

      const file = {
        buffer: makePngBuffer(900, 600),
        mimetype: 'image/png',
        size: 64,
      } as Express.Multer.File;

      const res = await service.uploadDraft(staffWithPerm, file, {
        speciesId: 'sp-tilapia',
        title: 'Fresh Tilapia Side View',
        jamaicanAliases: ['Red Belly', 'Tilapia'],
        photographer: 'Jane Photographer',
        sourceName: 'Studio Upload',
        licenseName: 'Company Owned',
        modifications: 'Cropped 3:2',
      });

      expect(storage.uploadPrivateDraft).toHaveBeenCalled();
      expect(storage.uploadPublishedVersion).not.toHaveBeenCalled();
      expect(res.lifecycleStatus).toBe('DRAFT');
      expect(res.storageContainer).toBe('catalogue-photos-drafts');
      expect(res.imageUrl).toContain('/api/v1/admin/catalogue-photos/');
      expect(txMock.cataloguePhotoAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: CataloguePhotoAuditAction.UPLOAD_DRAFT,
            actorUserId: staffWithPerm.id,
          }),
        }),
      );
    });

    it('rejects non-admin attempting immediate publish on replace, and keeps existing products untouched by default', async () => {
      const { service, prisma, txMock, storage, tilapiaSpecies } = buildService();
      const file = {
        buffer: makePngBuffer(900, 600),
        mimetype: 'image/png',
        size: 64,
      } as Express.Multer.File;

      await expect(
        service.replacePhoto(staffWithPerm, 'old-photo', file, { publishImmediately: true }),
      ).rejects.toThrow(ForbiddenException);

      const now = new Date();
      prisma.cataloguePhoto.findUnique.mockResolvedValue({
        id: 'old-photo',
        speciesId: 'sp-tilapia',
        catalogueItemId: 'cat-1',
        versionGroupId: 'group-1',
        versionNumber: 1,
        replacesPhotoId: null,
        isDefault: true,
        title: 'Tilapia v1',
        scientificName: 'Oreochromis niloticus',
        jamaicanAliases: ['Red Belly', 'Tilapia'],
        imageUrl: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v1.png',
        sourceName: 'Wikimedia',
        sourceUrl: 'https://example.com',
        photographer: 'Photog 1',
        licenseName: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        modifications: 'None',
        requiresAttribution: true,
        approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
        species: tilapiaSpecies,
        _count: { products: 3 },
      });
      txMock.cataloguePhoto.create.mockResolvedValue({
        id: 'new-photo-v2',
        speciesId: 'sp-tilapia',
        catalogueItemId: 'cat-1',
        versionGroupId: 'group-1',
        versionNumber: 2,
        replacesPhotoId: 'old-photo',
        isDefault: false,
        title: 'Tilapia v2',
        scientificName: 'Oreochromis niloticus',
        jamaicanAliases: ['Red Belly', 'Tilapia'],
        imageUrl:
          'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v2-uuid.png',
        storageProvider: 'AZURE_BLOB',
        storageContainer: 'catalogue-photos',
        storageKey: 'published/tilapia/group-1/v2-uuid.png',
        mimeType: 'image/png',
        fileSizeBytes: 64,
        widthPx: 900,
        heightPx: 600,
        sourceName: 'Wikimedia',
        sourceUrl: 'https://example.com',
        photographer: 'Photog 2',
        licenseName: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        modifications: 'Cropped 3:2',
        requiresAttribution: true,
        approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
        publishedAt: now,
        rejectedAt: null,
        rejectionReason: null,
        retiredAt: null,
        retirementReason: null,
        createdAt: now,
        updatedAt: now,
        species: tilapiaSpecies,
        uploadedByUser: null,
        publishedByUser: null,
        rejectedByUser: null,
        retiredByUser: null,
        _count: { products: 0 },
      });

      const replaced = await service.replacePhoto(adminWithPerm, 'old-photo', file, {
        title: 'Tilapia v2',
        photographer: 'Photog 2',
        publishImmediately: true,
      });

      expect(replaced.oldVersionUsageCount).toBe(3);
      expect(replaced.photo.versionNumber).toBe(2);
      expect(replaced.photo.storageKey).toBe('published/tilapia/group-1/v2-uuid.png');
      expect(storage.uploadPublishedVersion).toHaveBeenCalled();
      expect(txMock.product.updateMany).not.toHaveBeenCalled();
    });

    it('requires explicit confirmation for bulk-switching listings and preserves count/audit on retire', async () => {
      const { service, prisma, txMock, tilapiaSpecies } = buildService();

      await expect(
        service.bulkSwitchListings(adminWithPerm, 'to-id', {
          fromPhotoId: 'from-id',
          confirmBulkSwitch: false,
        }),
      ).rejects.toThrow(BadRequestException);

      prisma.cataloguePhoto.findUnique
        .mockResolvedValueOnce({
          id: 'from-id',
          speciesId: 'sp-tilapia',
          versionGroupId: 'group-1',
          versionNumber: 1,
        })
        .mockResolvedValueOnce({
          id: 'to-id',
          speciesId: 'sp-tilapia',
          versionGroupId: 'group-1',
          versionNumber: 2,
          approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
          retiredAt: null,
          imageUrl: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v2.png',
        });

      const switched = await service.bulkSwitchListings(adminWithPerm, 'to-id', {
        fromPhotoId: 'from-id',
        confirmBulkSwitch: true,
      });
      expect(switched.switchedCount).toBe(2);
      expect(txMock.product.updateMany).toHaveBeenCalledWith({
        where: { cataloguePhotoId: 'from-id' },
        data: {
          cataloguePhotoId: 'to-id',
          imageUrl: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/group-1/v2.png',
        },
      });
      expect(txMock.cataloguePhotoAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: CataloguePhotoAuditAction.BULK_SWITCH_LISTINGS,
            affectedCount: 2,
          }),
        }),
      );

      // Retire preserves existing references and logs count
      prisma.cataloguePhoto.findUnique.mockResolvedValueOnce({
        id: 'from-id',
        retiredAt: null,
        _count: { products: 1 },
      });
      const now = new Date();
      txMock.cataloguePhoto.update.mockResolvedValue({
        id: 'from-id',
        speciesId: 'sp-tilapia',
        catalogueItemId: 'cat-1',
        versionGroupId: 'group-1',
        versionNumber: 1,
        replacesPhotoId: null,
        isDefault: false,
        title: 'Tilapia v1',
        scientificName: 'Oreochromis niloticus',
        jamaicanAliases: ['Tilapia'],
        imageUrl: 'https://example.com/v1.png',
        storageProvider: 'AZURE_BLOB',
        storageContainer: 'catalogue-photos',
        storageKey: 'published/tilapia/group-1/v1.png',
        mimeType: 'image/png',
        fileSizeBytes: 64,
        widthPx: 900,
        heightPx: 600,
        sourceName: 'Wikimedia',
        sourceUrl: 'https://example.com',
        photographer: 'Photog 1',
        licenseName: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        modifications: 'None',
        requiresAttribution: true,
        approvalStatus: CataloguePhotoApprovalStatus.APPROVED,
        publishedAt: now,
        rejectedAt: null,
        rejectionReason: null,
        retiredAt: now,
        retirementReason: 'Superseded by clearer v2 photo',
        createdAt: now,
        updatedAt: now,
        species: tilapiaSpecies,
        uploadedByUser: null,
        publishedByUser: null,
        rejectedByUser: null,
        retiredByUser: null,
        _count: { products: 1 },
      });

      const retired = await service.retire(adminWithPerm, 'from-id', {
        reason: 'Superseded by clearer v2 photo',
      });
      expect(retired.lifecycleStatus).toBe('RETIRED');
      expect(retired.usageCount).toBe(1);
    });
  });
});
