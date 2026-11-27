import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RoleName, UserStatus } from '@prisma/client';
import { Request } from 'express';

import { ADMIN_PORTAL_ROLES, hasAdminPortalRole, isAdministratorRole } from '../auth/admin-roles';
import { PrismaService } from '../../database/prisma.service';

export interface RequestUser {
  id: string;
  email: string;
  roles: RoleName[];
  canAuthorizeVendorSettlements?: boolean;
  canManageCataloguePhotos?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: RequestUser;
}

interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: RoleName[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing authentication token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication token');
    }

    if (typeof this.prisma?.user?.findUnique === 'function') {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          status: true,
          canAuthorizeVendorSettlements: true,
          canManageCataloguePhotos: true,
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

      if (!dbUser) {
        throw new UnauthorizedException('Invalid or expired authentication token');
      }

      if (dbUser.status === UserStatus.SUSPENDED || dbUser.status === UserStatus.DEACTIVATED) {
        throw new ForbiddenException('This account is not permitted to access this resource');
      }

      const dbRoles = dbUser.roles.map((entry) => entry.role.name);
      const effectiveRoles =
        dbUser.status === UserStatus.ACTIVE
          ? dbRoles
          : dbRoles.filter((role) => !ADMIN_PORTAL_ROLES.includes(role));
      const canAuthorizeVendorSettlements =
        dbUser.status === UserStatus.ACTIVE &&
        Boolean(dbUser.canAuthorizeVendorSettlements) &&
        isAdministratorRole(effectiveRoles);
      const canManageCataloguePhotos =
        dbUser.status === UserStatus.ACTIVE &&
        Boolean(dbUser.canManageCataloguePhotos) &&
        hasAdminPortalRole(effectiveRoles);

      request.user = {
        id: dbUser.id,
        email: dbUser.email,
        roles: effectiveRoles,
        canAuthorizeVendorSettlements,
        canManageCataloguePhotos,
      };
      return true;
    }

    request.user = { id: payload.sub, email: payload.email, roles: payload.roles };
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' ? token : undefined;
  }
}
