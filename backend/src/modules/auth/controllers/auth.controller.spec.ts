import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';
import { Request, Response } from 'express';

import { REFRESH_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_PATH } from '../constants/auth.constants';
import { AuthenticatedSession, AuthService } from '../services/auth.service';
import { AuthController } from './auth.controller';

function createResponse(): jest.Mocked<Pick<Response, 'cookie' | 'clearCookie'>> {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

const session: AuthenticatedSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: 'user-1',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    phone: null,
    status: UserStatus.ACTIVE,
    roles: [RoleName.CUSTOMER],
    createdAt: new Date(),
  },
};

describe('AuthController', () => {
  let authService: jest.Mocked<
    Pick<AuthService, 'register' | 'login' | 'logout' | 'refresh' | 'forgotPassword' | 'resetPassword' | 'verifyEmail'>
  >;
  let configService: jest.Mocked<Pick<ConfigService, 'get' | 'getOrThrow'>>;
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      logout: jest.fn(),
      refresh: jest.fn(),
      forgotPassword: jest.fn(),
      resetPassword: jest.fn(),
      verifyEmail: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue('development'),
      getOrThrow: jest.fn().mockReturnValue('7d'),
    };

    controller = new AuthController(
      authService as unknown as AuthService,
      configService as unknown as ConfigService,
    );
  });

  it('registers a user and returns the public profile', async () => {
    authService.register.mockResolvedValue({
      user: session.user,
      emailVerificationToken: 'raw-token',
    });

    const result = await controller.register({
      email: 'jane@example.com',
      password: 'StrongPass1',
      confirmPassword: 'StrongPass1',
      firstName: 'Jane',
      lastName: 'Doe',
    });

    expect(result).toEqual(session.user);
  });

  it('logs in and sets the refresh token cookie', async () => {
    authService.login.mockResolvedValue(session);
    const res = createResponse();

    const result = await controller.login(
      { email: 'jane@example.com', password: 'StrongPass1' },
      res as unknown as Response,
    );

    expect(result).toEqual(session);
    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE_NAME,
      'refresh-token',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: REFRESH_TOKEN_COOKIE_PATH,
      }),
    );
  });

  it('sets a cross-site cookie (SameSite=None + Secure) when configured', async () => {
    // REFRESH_COOKIE_SAMESITE=none is the cross-site deployment mode (e.g.
    // the Codespaces demo). Secure must be forced on even outside production
    // - browsers reject SameSite=None cookies without it.
    configService.get.mockImplementation((key: string) =>
      key === 'REFRESH_COOKIE_SAMESITE' ? 'none' : 'development',
    );
    authService.login.mockResolvedValue(session);
    const res = createResponse();

    await controller.login(
      { email: 'jane@example.com', password: 'StrongPass1' },
      res as unknown as Response,
    );

    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE_NAME,
      'refresh-token',
      expect.objectContaining({ sameSite: 'none', secure: true }),
    );
  });

  it('logs out using the cookie token and clears the cookie', async () => {
    const req = { cookies: { [REFRESH_TOKEN_COOKIE_NAME]: 'cookie-token' } } as unknown as Request;
    const res = createResponse();

    const result = await controller.logout({}, req, res as unknown as Response);

    expect(authService.logout).toHaveBeenCalledWith('cookie-token');
    // Clearing sends the same attributes the cookie was set with (default
    // posture: strict, non-secure outside production).
    expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_TOKEN_COOKIE_NAME, {
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: REFRESH_TOKEN_COOKIE_PATH,
    });
    expect(result).toEqual({ success: true });
  });

  it('logs out using the body token when no cookie is present', async () => {
    const req = { cookies: {} } as unknown as Request;
    const res = createResponse();

    await controller.logout({ refreshToken: 'body-token' }, req, res as unknown as Response);

    expect(authService.logout).toHaveBeenCalledWith('body-token');
  });

  it('does not call logout when no refresh token is provided', async () => {
    const req = { cookies: {} } as unknown as Request;
    const res = createResponse();

    await controller.logout({}, req, res as unknown as Response);

    expect(authService.logout).not.toHaveBeenCalled();
  });

  it('refreshes the session and rotates the cookie', async () => {
    authService.refresh.mockResolvedValue(session);
    const req = { cookies: { [REFRESH_TOKEN_COOKIE_NAME]: 'old-token' } } as unknown as Request;
    const res = createResponse();

    const result = await controller.refresh({}, req, res as unknown as Response);

    expect(authService.refresh).toHaveBeenCalledWith('old-token');
    expect(result).toEqual(session);
    expect(res.cookie).toHaveBeenCalled();
  });

  it('throws and clears the cookie when no refresh token is provided', async () => {
    const req = { cookies: {} } as unknown as Request;
    const res = createResponse();

    await expect(
      controller.refresh({}, req, res as unknown as Response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalled();
  });

  it('always reports success for forgot-password regardless of outcome', async () => {
    const result = await controller.forgotPassword({ email: 'jane@example.com' });
    expect(result).toEqual({ success: true });
    expect(authService.forgotPassword).toHaveBeenCalled();
  });

  it('resets the password', async () => {
    const result = await controller.resetPassword({
      token: 'raw-token',
      newPassword: 'NewStrongPass1',
      confirmPassword: 'NewStrongPass1',
    });
    expect(result).toEqual({ success: true });
  });

  it('verifies the email', async () => {
    const result = await controller.verifyEmail({ token: 'raw-token' });
    expect(result).toEqual({ success: true });
  });

  it('returns the current authenticated user', () => {
    const user = { id: 'user-1', email: 'jane@example.com', roles: [RoleName.CUSTOMER] };
    expect(controller.me(user)).toBe(user);
  });
});
