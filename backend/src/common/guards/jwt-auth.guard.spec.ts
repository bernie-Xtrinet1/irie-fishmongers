import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';

function createContext(headers: Record<string, string>): {
  context: ExecutionContext;
  request: Partial<AuthenticatedRequest>;
} {
  const request: Partial<AuthenticatedRequest> = { headers };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard', () => {
  let jwtService: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'getOrThrow'>>;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    configService = { getOrThrow: jest.fn().mockReturnValue('access-secret') };
    guard = new JwtAuthGuard(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  it('attaches the decoded user and allows access for a valid bearer token', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      email: 'jane@example.com',
      roles: ['CUSTOMER'],
    });
    const { context, request } = createContext({ authorization: 'Bearer valid.token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-1', email: 'jane@example.com', roles: ['CUSTOMER'] });
  });

  it('throws when the authorization header is missing', async () => {
    const { context } = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws when the authorization scheme is not Bearer', async () => {
    const { context } = createContext({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws when the token fails verification', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const { context } = createContext({ authorization: 'Bearer bad.token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
