import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RoleName, UserStatus } from '@prisma/client';

import { AuthenticatedRequest } from '../../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../../database/prisma.service';
import { PrimaryAdminVendorSettlementGuard } from './primary-admin-vendor-settlement.guard';

function makeContext(user?: AuthenticatedRequest['user']): {
  context: ExecutionContext;
  request: Partial<AuthenticatedRequest>;
} {
  const request: Partial<AuthenticatedRequest> = { user };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('PrimaryAdminVendorSettlementGuard', () => {
  it('allows an active designated primary administrator verified against DB', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'bernard.uat@iriefishmongers.test',
          status: UserStatus.ACTIVE,
          canAuthorizeVendorSettlements: true,
          roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
        }),
      },
    } as unknown as PrismaService;
    const guard = new PrimaryAdminVendorSettlementGuard(prismaMock);
    const { context, request } = makeContext({
      id: 'admin-1',
      email: 'bernard.uat@iriefishmongers.test',
      roles: [RoleName.ADMINISTRATOR],
      canAuthorizeVendorSettlements: false,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.canAuthorizeVendorSettlements).toBe(true);
  });

  it('denies an ordinary administrator when canAuthorizeVendorSettlements is false in DB', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-2',
          email: 'admin@demo.iriefishmongers.test',
          status: UserStatus.ACTIVE,
          canAuthorizeVendorSettlements: false,
          roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
        }),
      },
    } as unknown as PrismaService;
    const guard = new PrimaryAdminVendorSettlementGuard(prismaMock);
    const { context } = makeContext({
      id: 'admin-2',
      email: 'admin@demo.iriefishmongers.test',
      roles: [RoleName.ADMINISTRATOR],
      canAuthorizeVendorSettlements: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies operations staff even if DB flag were set', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'staff-1',
          email: 'staff.operations@iriefishmongers.test',
          status: UserStatus.ACTIVE,
          canAuthorizeVendorSettlements: true,
          roles: [{ role: { name: RoleName.OPERATIONS_STAFF } }],
        }),
      },
    } as unknown as PrismaService;
    const guard = new PrimaryAdminVendorSettlementGuard(prismaMock);
    const { context } = makeContext({
      id: 'staff-1',
      email: 'staff.operations@iriefishmongers.test',
      roles: [RoleName.OPERATIONS_STAFF],
      canAuthorizeVendorSettlements: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies suspended or non-active administrators', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'bernard.uat@iriefishmongers.test',
          status: UserStatus.PENDING_VERIFICATION,
          canAuthorizeVendorSettlements: true,
          roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
        }),
      },
    } as unknown as PrismaService;
    const guard = new PrimaryAdminVendorSettlementGuard(prismaMock);
    const { context } = makeContext({
      id: 'admin-1',
      email: 'bernard.uat@iriefishmongers.test',
      roles: [RoleName.ADMINISTRATOR],
      canAuthorizeVendorSettlements: true,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
