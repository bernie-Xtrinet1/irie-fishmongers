import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotImplementedException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';

import { AuthenticatedRequest } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import {
  REFUND_RECONCILIATION_API_POLICY,
  RefundReconciliationEndpointPolicy,
} from '../types/refund-dual-control.types';

/**
 * Fail-closed gate keeping dual-control refund reconciliation endpoints disabled
 * by default in production and whenever not explicitly enabled in isolated dev/tests.
 */
@Injectable()
export class RefundReconciliationEndpointGateGuard implements CanActivate {
  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    @Inject(REFUND_RECONCILIATION_API_POLICY)
    private readonly policy?: Partial<RefundReconciliationEndpointPolicy>,
  ) {}

  canActivate(): boolean {
    const nodeEnv = this.configService?.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      throw new NotImplementedException(
        'Dual-control refund reconciliation endpoints are disabled in production',
      );
    }

    const enabledByPolicy = this.policy?.enabled === true;
    const enabledByEnv =
      (this.configService?.get<string>('REFUND_RECONCILIATION_API_ENABLED') ??
        process.env.REFUND_RECONCILIATION_API_ENABLED) === 'true';

    if (!enabledByPolicy && !enabledByEnv) {
      throw new NotImplementedException(
        'Dual-control refund reconciliation endpoints are disabled pending explicit activation',
      );
    }

    return true;
  }
}

/**
 * Revalidates against PostgreSQL that the authenticated user exists, is ACTIVE,
 * and currently holds RoleName.ADMINISTRATOR (rejects suspended/demoted JWTs).
 */
@Injectable()
export class ActiveAdministratorGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actorId = request.user?.id?.trim();
    if (!actorId) {
      throw new UnauthorizedException('Authenticated administrator identity is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: {
        id: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Administrator account is inactive or missing');
    }

    const isAdmin = user.roles.some((ur) => ur.role.name === RoleName.ADMINISTRATOR);
    if (!isAdmin) {
      throw new ForbiddenException('Active ADMINISTRATOR role is required');
    }

    return true;
  }
}
