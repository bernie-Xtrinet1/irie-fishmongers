import {
  ExecutionContext,
  ForbiddenException,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';

import {
  ActiveAdministratorGuard,
  RefundReconciliationEndpointGateGuard,
} from './refund-reconciliation-endpoint-gate.guard';

describe('RefundReconciliationEndpointGateGuard & ActiveAdministratorGuard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiFlag = process.env.REFUND_RECONCILIATION_API_ENABLED;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalApiFlag === undefined) {
      delete process.env.REFUND_RECONCILIATION_API_ENABLED;
    } else {
      process.env.REFUND_RECONCILIATION_API_ENABLED = originalApiFlag;
    }
  });

  it('fails closed in production even if policy and env flag are enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.REFUND_RECONCILIATION_API_ENABLED = 'true';
    const config = {
      get: (k: string) =>
        k === 'NODE_ENV' ? 'production' : k === 'REFUND_RECONCILIATION_API_ENABLED' ? 'true' : undefined,
    } as unknown as ConfigService;

    const guard = new RefundReconciliationEndpointGateGuard(config, { enabled: true });
    expect(() => guard.canActivate()).toThrow(NotImplementedException);
  });

  it('fails closed when disabled by default policy and env flag is absent', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REFUND_RECONCILIATION_API_ENABLED;
    const config = { get: () => undefined } as unknown as ConfigService;

    const guard = new RefundReconciliationEndpointGateGuard(config, { enabled: false });
    expect(() => guard.canActivate()).toThrow(NotImplementedException);
  });

  it('allows access only in non-production when explicitly enabled by policy or env', () => {
    process.env.NODE_ENV = 'test';
    const config = { get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined) } as unknown as ConfigService;

    expect(new RefundReconciliationEndpointGateGuard(config, { enabled: true }).canActivate()).toBe(
      true,
    );

    process.env.REFUND_RECONCILIATION_API_ENABLED = 'true';
    expect(new RefundReconciliationEndpointGateGuard(config, { enabled: false }).canActivate()).toBe(
      true,
    );
  });

  it('ActiveAdministratorGuard rejects missing, inactive, or demoted administrator accounts', async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn(),
      },
    };
    const guard = new ActiveAdministratorGuard(prismaMock as never);
    const makeCtx = (user?: { id?: string }) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as unknown as ExecutionContext;

    await expect(guard.canActivate(makeCtx(undefined))).rejects.toThrow(UnauthorizedException);

    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'u-suspended',
      status: UserStatus.SUSPENDED,
      roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
    });
    await expect(guard.canActivate(makeCtx({ id: 'u-suspended' }))).rejects.toThrow(
      ForbiddenException,
    );

    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'u-demoted',
      status: UserStatus.ACTIVE,
      roles: [{ role: { name: RoleName.CUSTOMER } }],
    });
    await expect(guard.canActivate(makeCtx({ id: 'u-demoted' }))).rejects.toThrow(
      ForbiddenException,
    );

    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: 'u-admin',
      status: UserStatus.ACTIVE,
      roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
    });
    await expect(guard.canActivate(makeCtx({ id: 'u-admin' }))).resolves.toBe(true);
  });
});
