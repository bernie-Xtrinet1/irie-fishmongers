import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';

import { AuthenticatedRequest } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

function createContext(user?: AuthenticatedRequest['user']): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows access when no roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(createContext())).toBe(true);
  });

  it('allows access when the user has one of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([RoleName.ADMINISTRATOR]);

    const context = createContext({
      id: 'user-1',
      email: 'a@b.com',
      roles: [RoleName.ADMINISTRATOR],
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies access when the user lacks the required role', () => {
    reflector.getAllAndOverride.mockReturnValue([RoleName.ADMINISTRATOR]);

    const context = createContext({ id: 'user-1', email: 'a@b.com', roles: [RoleName.CUSTOMER] });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denies access when there is no authenticated user', () => {
    reflector.getAllAndOverride.mockReturnValue([RoleName.ADMINISTRATOR]);

    expect(() => guard.canActivate(createContext(undefined))).toThrow(ForbiddenException);
  });
});
