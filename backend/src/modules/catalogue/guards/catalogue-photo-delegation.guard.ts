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

export const CATALOGUE_PHOTO_DELEGATION_FORBIDDEN_MESSAGE =
  'Only an active designated Primary Administrator may grant or revoke Catalogue Photos staff access';

/**
 * Enforces that Catalogue Photos staff access delegation is performed strictly by
 * an ACTIVE ADMINISTRATOR carrying the authoritative Primary Administrator DB
 * permission (`canAuthorizeVendorSettlements = true`), re-verified from PostgreSQL
 * on every request.
 */
@Injectable()
export class CataloguePhotoDelegationGuard implements CanActivate {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = await resolveCatalogueActor(request.user, this.prisma);

    if (
      !actor ||
      actor.status !== UserStatus.ACTIVE ||
      !isAdministratorRole(actor.roles) ||
      !actor.canAuthorizeVendorSettlements
    ) {
      throw new ForbiddenException(CATALOGUE_PHOTO_DELEGATION_FORBIDDEN_MESSAGE);
    }

    request.user = {
      ...request.user,
      id: actor.id,
      email: actor.email,
      roles: actor.roles,
      canAuthorizeVendorSettlements: true,
      canManageCataloguePhotos: actor.canManageCataloguePhotos,
    };
    return true;
  }
}
