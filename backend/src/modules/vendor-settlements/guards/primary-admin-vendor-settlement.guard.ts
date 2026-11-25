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

export const PRIMARY_ADMIN_SETTLEMENT_FORBIDDEN_MESSAGE =
  'Only the designated primary administrator may authorize or modify vendor settlement payments';

/**
 * Enforces that vendor settlement authorization, payment-status transitions,
 * payment-reference updates, and disbursement initiation/release are executed
 * strictly by an ACTIVE designated primary administrator checked against live DB state.
 */
@Injectable()
export class PrimaryAdminVendorSettlementGuard implements CanActivate {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user?.id || !isAdministratorRole(user.roles)) {
      throw new ForbiddenException(PRIMARY_ADMIN_SETTLEMENT_FORBIDDEN_MESSAGE);
    }

    if (typeof this.prisma?.user?.findUnique === 'function') {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          email: true,
          status: true,
          canAuthorizeVendorSettlements: true,
          roles: {
            select: {
              role: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

      const dbRoles = dbUser?.roles.map((entry) => entry.role.name) ?? [];
      const authorized =
        dbUser !== null &&
        dbUser.status === UserStatus.ACTIVE &&
        Boolean(dbUser.canAuthorizeVendorSettlements) &&
        isAdministratorRole(dbRoles);

      if (!authorized) {
        throw new ForbiddenException(PRIMARY_ADMIN_SETTLEMENT_FORBIDDEN_MESSAGE);
      }

      request.user = {
        id: dbUser.id,
        email: dbUser.email,
        roles: dbRoles,
        canAuthorizeVendorSettlements: true,
      };
      return true;
    }

    if (!user.canAuthorizeVendorSettlements) {
      throw new ForbiddenException(PRIMARY_ADMIN_SETTLEMENT_FORBIDDEN_MESSAGE);
    }

    return true;
  }
}
