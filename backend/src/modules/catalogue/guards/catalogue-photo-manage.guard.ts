import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { hasAdminPortalRole } from '../../../common/auth/admin-roles';
import { AuthenticatedRequest } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { resolveCatalogueActor } from './catalogue-photo-guard.helper';

export const CATALOGUE_PHOTO_MANAGE_FORBIDDEN_MESSAGE =
  'Explicit catalogue photo management permission is required to upload or edit catalogue photos';

/**
 * Enforces explicit permission (`User.canManageCataloguePhotos = true`) checked
 * against live DB state for uploading, editing, and replacing catalogue photos.
 */
@Injectable()
export class CataloguePhotoManageGuard implements CanActivate {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = await resolveCatalogueActor(request.user, this.prisma);

    if (
      !actor ||
      actor.status !== UserStatus.ACTIVE ||
      !actor.canManageCataloguePhotos ||
      !hasAdminPortalRole(actor.roles)
    ) {
      throw new ForbiddenException(CATALOGUE_PHOTO_MANAGE_FORBIDDEN_MESSAGE);
    }

    request.user = {
      ...request.user,
      id: actor.id,
      email: actor.email,
      roles: actor.roles,
      canManageCataloguePhotos: true,
    };
    return true;
  }
}
