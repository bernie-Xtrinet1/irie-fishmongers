import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName, UserPermissionAuditAction, UserStatus } from '@prisma/client';

import { isAdministratorRole } from '../../../common/auth/admin-roles';
import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { UpdateCataloguePhotoStaffAccessDto } from '../dto/catalogue-photo-staff-access.dto';

export const CATALOGUE_PHOTO_PERMISSION_KEY = 'canManageCataloguePhotos';

export interface SerializedStaffAccessUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  roles: RoleName[];
  canManageCataloguePhotos: boolean;
  updatedAt: string;
}

export interface SerializedUserPermissionAuditLog {
  id: string;
  targetUserId: string;
  targetEmail: string;
  actorUserId: string;
  actorEmail: string;
  permissionName: string;
  action: UserPermissionAuditAction;
  previousValue: boolean;
  newValue: boolean;
  createdAt: string;
}

interface StaffUserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  canManageCataloguePhotos: boolean;
  updatedAt: Date;
  roles: Array<{ role: { name: RoleName } }>;
}

interface AuditLogRow {
  id: string;
  targetUserId: string;
  targetEmail: string;
  actorUserId: string;
  actorEmail: string;
  permissionName: string;
  action: UserPermissionAuditAction;
  previousValue: boolean;
  newValue: boolean;
  createdAt: Date;
}

/**
 * Manages Primary Administrator delegation and audit logging of
 * `User.canManageCataloguePhotos` for active Operations Staff accounts.
 */
@Injectable()
export class CataloguePhotoStaffAccessService {
  constructor(private readonly prisma: PrismaService) {}

  static serializeStaff(row: StaffUserRow): SerializedStaffAccessUser {
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      status: row.status,
      roles: row.roles.map((r) => r.role.name),
      canManageCataloguePhotos: Boolean(row.canManageCataloguePhotos),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  static serializeAudit(row: AuditLogRow): SerializedUserPermissionAuditLog {
    return {
      id: row.id,
      targetUserId: row.targetUserId,
      targetEmail: row.targetEmail,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      permissionName: row.permissionName,
      action: row.action,
      previousValue: row.previousValue,
      newValue: row.newValue,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listEligibleStaffAndAuditLogs(): Promise<{
    staff: SerializedStaffAccessUser[];
    auditLogs: SerializedUserPermissionAuditLog[];
  }> {
    const [staffRows, auditRows] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          status: UserStatus.ACTIVE,
          roles: {
            some: { role: { name: RoleName.OPERATIONS_STAFF } },
            none: { role: { name: RoleName.ADMINISTRATOR } },
          },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          canManageCataloguePhotos: true,
          updatedAt: true,
          roles: {
            select: {
              role: { select: { name: true } },
            },
          },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { email: 'asc' }],
      }),
      this.prisma.userPermissionAuditLog.findMany({
        where: { permissionName: CATALOGUE_PHOTO_PERMISSION_KEY },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);

    return {
      staff: staffRows.map((row) => CataloguePhotoStaffAccessService.serializeStaff(row)),
      auditLogs: auditRows.map((row) => CataloguePhotoStaffAccessService.serializeAudit(row)),
    };
  }

  async updateStaffAccess(
    actor: RequestUser,
    dto: UpdateCataloguePhotoStaffAccessDto,
  ): Promise<{
    changed: boolean;
    staff: SerializedStaffAccessUser;
    auditLog: SerializedUserPermissionAuditLog | null;
  }> {
    if (dto.targetUserId === actor.id) {
      throw new BadRequestException(
        'Self-grant and self-revocation of Catalogue Photos access are not permitted.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Lock the target user row first so concurrent permission changes on the
      // same account serialize and record an accurate before/after audit chain.
      if (typeof tx.$queryRaw === 'function') {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${dto.targetUserId} FOR UPDATE`;
      }

      const target = await tx.user.findUnique({
        where: { id: dto.targetUserId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          canManageCataloguePhotos: true,
          updatedAt: true,
          roles: {
            select: {
              role: { select: { name: true } },
            },
          },
        },
      });

      if (!target) {
        throw new NotFoundException('Target staff account not found');
      }

      if (target.id === actor.id) {
        throw new BadRequestException(
          'Self-grant and self-revocation of Catalogue Photos access are not permitted.',
        );
      }

      if (target.status !== UserStatus.ACTIVE) {
        throw new BadRequestException(
          'Catalogue Photos access can only be managed for active Operations Staff accounts.',
        );
      }

      const targetRoles = target.roles.map((r) => r.role.name);
      if (!targetRoles.includes(RoleName.OPERATIONS_STAFF) || isAdministratorRole(targetRoles)) {
        throw new BadRequestException(
          'Catalogue Photos access delegation applies strictly to Operations Staff accounts.',
        );
      }

      const previousValue = Boolean(target.canManageCataloguePhotos);
      if (previousValue === dto.canManageCataloguePhotos) {
        return {
          changed: false,
          staff: CataloguePhotoStaffAccessService.serializeStaff(target),
          auditLog: null,
        };
      }

      const updatedUser = await tx.user.update({
        where: { id: target.id },
        data: { canManageCataloguePhotos: dto.canManageCataloguePhotos },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          canManageCataloguePhotos: true,
          updatedAt: true,
          roles: {
            select: {
              role: { select: { name: true } },
            },
          },
        },
      });

      const auditEntry = await tx.userPermissionAuditLog.create({
        data: {
          targetUserId: target.id,
          targetEmail: target.email,
          actorUserId: actor.id,
          actorEmail: actor.email,
          permissionName: CATALOGUE_PHOTO_PERMISSION_KEY,
          action: dto.canManageCataloguePhotos
            ? UserPermissionAuditAction.GRANT_CATALOGUE_PHOTO_ACCESS
            : UserPermissionAuditAction.REVOKE_CATALOGUE_PHOTO_ACCESS,
          previousValue,
          newValue: dto.canManageCataloguePhotos,
        },
      });

      return {
        changed: true,
        staff: CataloguePhotoStaffAccessService.serializeStaff(updatedUser),
        auditLog: CataloguePhotoStaffAccessService.serializeAudit(auditEntry),
      };
    });
  }
}
