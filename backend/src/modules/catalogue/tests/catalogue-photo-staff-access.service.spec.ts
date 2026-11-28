import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { RoleName, UserPermissionAuditAction, UserStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { UpdateCataloguePhotoStaffAccessDto } from '../dto/catalogue-photo-staff-access.dto';
import {
  CATALOGUE_PHOTO_DELEGATION_FORBIDDEN_MESSAGE,
  CataloguePhotoDelegationGuard,
} from '../guards/catalogue-photo-delegation.guard';
import {
  CATALOGUE_PHOTO_PERMISSION_KEY,
  CataloguePhotoStaffAccessService,
} from '../services/catalogue-photo-staff-access.service';

describe('CataloguePhotoDelegationGuard & CataloguePhotoStaffAccessService', () => {
  const actorUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'bernard.uat@iriefishmongers.test',
    roles: [RoleName.ADMINISTRATOR],
  };

  function makeContext(user: Record<string, unknown> | undefined) {
    const request: { user?: Record<string, unknown> } = { user };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  }

  describe('CataloguePhotoDelegationGuard', () => {
    it('allows ACTIVE ADMINISTRATOR with live DB canAuthorizeVendorSettlements=true', async () => {
      const findUnique = jest.fn().mockResolvedValue({
        id: actorUser.id,
        email: actorUser.email,
        status: UserStatus.ACTIVE,
        canAuthorizeVendorSettlements: true,
        canManageCataloguePhotos: false,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });
      const guard = new CataloguePhotoDelegationGuard({
        user: { findUnique },
      } as unknown as PrismaService);

      const { ctx, request } = makeContext({
        id: actorUser.id,
        email: actorUser.email,
        roles: [RoleName.ADMINISTRATOR],
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(request.user).toMatchObject({
        id: actorUser.id,
        canAuthorizeVendorSettlements: true,
        canManageCataloguePhotos: false,
      });
    });

    it('rejects ordinary ADMINISTRATOR whose DB canAuthorizeVendorSettlements=false even if JWT claims true', async () => {
      const findUnique = jest.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin@demo.iriefishmongers.test',
        status: UserStatus.ACTIVE,
        canAuthorizeVendorSettlements: false,
        canManageCataloguePhotos: true,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });
      const guard = new CataloguePhotoDelegationGuard({
        user: { findUnique },
      } as unknown as PrismaService);

      const { ctx } = makeContext({
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin@demo.iriefishmongers.test',
        roles: [RoleName.ADMINISTRATOR],
        canAuthorizeVendorSettlements: true,
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new ForbiddenException(CATALOGUE_PHOTO_DELEGATION_FORBIDDEN_MESSAGE),
      );
    });

    it('rejects OPERATIONS_STAFF and suspended/revoked Primary Administrators from DB state', async () => {
      const findUnique = jest
        .fn()
        .mockResolvedValueOnce({
          id: '33333333-3333-4333-8333-333333333333',
          email: 'staff.operations@iriefishmongers.test',
          status: UserStatus.ACTIVE,
          canAuthorizeVendorSettlements: true,
          canManageCataloguePhotos: true,
          roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
        })
        .mockResolvedValueOnce({
          id: actorUser.id,
          email: actorUser.email,
          status: UserStatus.SUSPENDED,
          canAuthorizeVendorSettlements: true,
          canManageCataloguePhotos: true,
          roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
        });
      const guard = new CataloguePhotoDelegationGuard({
        user: { findUnique },
      } as unknown as PrismaService);

      const staffCtx = makeContext({
        id: '33333333-3333-4333-8333-333333333333',
        email: 'staff.operations@iriefishmongers.test',
        roles: [RoleName.OPERATIONS_STAFF],
      });
      await expect(guard.canActivate(staffCtx.ctx)).rejects.toThrow(ForbiddenException);

      const suspendedCtx = makeContext({
        id: actorUser.id,
        email: actorUser.email,
        roles: [RoleName.ADMINISTRATOR],
      });
      await expect(guard.canActivate(suspendedCtx.ctx)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('DTO input boundary', () => {
    it('accepts strictly targetUserId + boolean canManageCataloguePhotos and rejects unexpected fields', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });

      await expect(
        pipe.transform(
          {
            targetUserId: '33333333-3333-4333-8333-333333333333',
            canManageCataloguePhotos: true,
            canAuthorizeVendorSettlements: true,
          },
          { type: 'body', metatype: UpdateCataloguePhotoStaffAccessDto },
        ),
      ).rejects.toThrow(BadRequestException);

      const valid: unknown = await pipe.transform(
        {
          targetUserId: '33333333-3333-4333-8333-333333333333',
          canManageCataloguePhotos: false,
        },
        { type: 'body', metatype: UpdateCataloguePhotoStaffAccessDto },
      );
      expect(valid).toEqual({
        targetUserId: '33333333-3333-4333-8333-333333333333',
        canManageCataloguePhotos: false,
      });
    });
  });

  describe('CataloguePhotoStaffAccessService', () => {
    const targetId = '33333333-3333-4333-8333-333333333333';

    function makeServiceWithTx(tx: Record<string, unknown>) {
      const transactionMock = jest.fn((cb: (txClient: Record<string, unknown>) => Promise<unknown>) =>
        cb(tx),
      );
      const prisma = {
        user: { findMany: jest.fn() },
        userPermissionAuditLog: { findMany: jest.fn() },
        $transaction: transactionMock,
      } as unknown as PrismaService;
      return { service: new CataloguePhotoStaffAccessService(prisma), transactionMock };
    }

    it('blocks self-grant and self-revocation before opening a mutation', async () => {
      const { service, transactionMock } = makeServiceWithTx({});
      await expect(
        service.updateStaffAccess(actorUser, {
          targetUserId: actorUser.id,
          canManageCataloguePhotos: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when target user does not exist', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
        userPermissionAuditLog: { create: jest.fn() },
      };
      const { service } = makeServiceWithTx(tx);

      await expect(
        service.updateStaffAccess(actorUser, {
          targetUserId: targetId,
          canManageCataloguePhotos: true,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.userPermissionAuditLog.create).not.toHaveBeenCalled();
    });

    it('rejects non-ACTIVE targets, non-OPERATIONS_STAFF accounts, and accounts holding ADMINISTRATOR', async () => {
      const inactiveStaff = {
        id: targetId,
        email: 'suspended@iriefishmongers.test',
        firstName: 'Suspended',
        lastName: 'Staff',
        status: UserStatus.SUSPENDED,
        canManageCataloguePhotos: false,
        updatedAt: new Date('2026-11-28T00:00:00.000Z'),
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      };
      const vendorAccount = {
        ...inactiveStaff,
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.VENDOR } }],
      };
      const adminStaffHybrid = {
        ...inactiveStaff,
        status: UserStatus.ACTIVE,
        roles: [
          { role: { name: RoleName.OPERATIONS_STAFF } },
          { role: { name: RoleName.ADMINISTRATOR } },
        ],
      };

      const findUnique = jest
        .fn()
        .mockResolvedValueOnce(inactiveStaff)
        .mockResolvedValueOnce(vendorAccount)
        .mockResolvedValueOnce(adminStaffHybrid);

      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { findUnique, update: jest.fn() },
        userPermissionAuditLog: { create: jest.fn() },
      };
      const { service } = makeServiceWithTx(tx);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          service.updateStaffAccess(actorUser, {
            targetUserId: targetId,
            canManageCataloguePhotos: true,
          }),
        ).rejects.toThrow(BadRequestException);
      }
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.userPermissionAuditLog.create).not.toHaveBeenCalled();
    });

    it('treats idempotent repeat requests as no-ops without writing duplicate audit entries', async () => {
      const existing = {
        id: targetId,
        email: 'staff.operations@iriefishmongers.test',
        firstName: 'Ops',
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: true,
        updatedAt: new Date('2026-11-28T00:00:00.000Z'),
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: { findUnique: jest.fn().mockResolvedValue(existing), update: jest.fn() },
        userPermissionAuditLog: { create: jest.fn() },
      };
      const { service } = makeServiceWithTx(tx);

      const result = await service.updateStaffAccess(actorUser, {
        targetUserId: targetId,
        canManageCataloguePhotos: true,
      });

      expect(result.changed).toBe(false);
      expect(result.auditLog).toBeNull();
      expect(result.staff.canManageCataloguePhotos).toBe(true);
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.userPermissionAuditLog.create).not.toHaveBeenCalled();
    });

    it('updates flag and writes immutable audit record in the same transaction on grant and revoke', async () => {
      const beforeGrant = {
        id: targetId,
        email: 'staff.operations@iriefishmongers.test',
        firstName: 'Ops',
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
        canManageCataloguePhotos: false,
        updatedAt: new Date('2026-11-28T00:00:00.000Z'),
        roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
      };
      const afterGrant = {
        ...beforeGrant,
        canManageCataloguePhotos: true,
        updatedAt: new Date('2026-11-28T01:00:00.000Z'),
      };
      const auditGrant = {
        id: 'audit-grant-1',
        targetUserId: targetId,
        targetEmail: beforeGrant.email,
        actorUserId: actorUser.id,
        actorEmail: actorUser.email,
        permissionName: CATALOGUE_PHOTO_PERMISSION_KEY,
        action: UserPermissionAuditAction.GRANT_CATALOGUE_PHOTO_ACCESS,
        previousValue: false,
        newValue: true,
        createdAt: new Date('2026-11-28T01:00:00.000Z'),
      };

      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: {
          findUnique: jest.fn().mockResolvedValue(beforeGrant),
          update: jest.fn().mockResolvedValue(afterGrant),
        },
        userPermissionAuditLog: {
          create: jest.fn().mockResolvedValue(auditGrant),
        },
      };
      const { service } = makeServiceWithTx(tx);

      const res = await service.updateStaffAccess(actorUser, {
        targetUserId: targetId,
        canManageCataloguePhotos: true,
      });

      expect(res.changed).toBe(true);
      expect(res.staff.canManageCataloguePhotos).toBe(true);
      expect(res.auditLog).toMatchObject({
        action: UserPermissionAuditAction.GRANT_CATALOGUE_PHOTO_ACCESS,
        previousValue: false,
        newValue: true,
        actorUserId: actorUser.id,
        actorEmail: actorUser.email,
        targetUserId: targetId,
        targetEmail: beforeGrant.email,
      });
      const updateCall = (tx.user.update.mock.calls as Array<Array<Record<string, unknown>>>)[0]?.[0];
      expect(updateCall?.where).toEqual({ id: targetId });
      expect(updateCall?.data).toEqual({ canManageCataloguePhotos: true });

      const auditCall = (
        tx.userPermissionAuditLog.create.mock.calls as Array<Array<Record<string, unknown>>>
      )[0]?.[0];
      expect(auditCall?.data).toMatchObject({
        action: UserPermissionAuditAction.GRANT_CATALOGUE_PHOTO_ACCESS,
        previousValue: false,
        newValue: true,
        permissionName: CATALOGUE_PHOTO_PERMISSION_KEY,
      });
    });
  });
});
