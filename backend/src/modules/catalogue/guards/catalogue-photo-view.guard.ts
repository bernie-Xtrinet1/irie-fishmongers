import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { hasAdminPortalRole, isAdministratorRole } from '../../../common/auth/admin-roles';
import { AuthenticatedRequest } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { resolveCatalogueActor } from './catalogue-photo-guard.helper';

export const CATALOGUE_PHOTO_VIEW_FORBIDDEN_MESSAGE =
  'Administrator role or explicit catalogue photo permission is required';

/**
 * Allows reading private catalogue photo drafts and audit history strictly for
 * ACTIVE ADMINISTRATOR accounts or ACTIVE portal staff with explicit
 * `canManageCataloguePhotos` permission.
 */
@Injectable()
export class CataloguePhotoViewGuard implements CanActivate {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = await resolveCatalogueActor(request.user, this.prisma);

    const authorized =
      actor !== null &&
      actor.status === UserStatus.ACTIVE &&
      (isAdministratorRole(actor.roles) ||
        (hasAdminPortalRole(actor.roles) && actor.canManageCataloguePhotos));

    if (!authorized || !actor) {
      throw new ForbiddenException(CATALOGUE_PHOTO_VIEW_FORBIDDEN_MESSAGE);
    }

    request.user = {
      ...request.user,
      id: actor.id,
      email: actor.email,
      roles: actor.roles,
      canManageCataloguePhotos: actor.canManageCataloguePhotos,
    };
    return true;
  }
}
