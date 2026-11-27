import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { isAdministratorRole } from '../../../common/auth/admin-roles';
import { AuthenticatedRequest } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { resolveCatalogueActor } from './catalogue-photo-guard.helper';

export const CATALOGUE_PHOTO_ADMIN_FORBIDDEN_MESSAGE =
  'Only active administrators may publish, change defaults, retire, or bulk-switch catalogue photos';

/**
 * Reserves publishing, default-photo assignment, retirement, rollback, and
 * bulk listing image replacement strictly to ACTIVE ADMINISTRATOR accounts.
 */
@Injectable()
export class CataloguePhotoAdminGuard implements CanActivate {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = await resolveCatalogueActor(request.user, this.prisma);

    if (!actor || actor.status !== UserStatus.ACTIVE || !isAdministratorRole(actor.roles)) {
      throw new ForbiddenException(CATALOGUE_PHOTO_ADMIN_FORBIDDEN_MESSAGE);
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
