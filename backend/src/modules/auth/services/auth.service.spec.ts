import * as bcrypt from 'bcrypt';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Role, RoleName, UserStatus } from '@prisma/client';

import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { RolesRepository } from '../repositories/roles.repository';
import { UsersRepository, UserWithRoles } from '../repositories/users.repository';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

function buildUser(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  const role: Role = {
    id: 'role-1',
    name: RoleName.CUSTOMER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    id: 'user-1',
    email: 'jane@example.com',
    passwordHash: 'hashed',
    firstName: 'Jane',
    lastName: 'Doe',
    phone: null,
    status: UserStatus.ACTIVE,
    emailVerifiedAt: null,
    emailVerificationTokenHash: null,
    emailVerificationTokenExpiresAt: null,
    passwordResetTokenHash: null,
    passwordResetTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: [{ id: 'ur-1', userId: 'user-1', roleId: 'role-1', createdAt: new Date(), role }],
    ...overrides,
  };
}

describe('AuthService', () => {
  let usersRepository: jest.Mocked<
    Pick<
      UsersRepository,
      | 'findByEmail'
      | 'findById'
      | 'create'
      | 'markEmailVerified'
      | 'setPasswordResetToken'
      | 'resetPassword'
      | 'findByPasswordResetTokenHash'
      | 'findByEmailVerificationTokenHash'
    >
  >;
  let rolesRepository: jest.Mocked<Pick<RolesRepository, 'findByName'>>;
  let refreshTokensRepository: jest.Mocked<Pick<RefreshTokensRepository, 'revokeAllForUser'>>;
  let tokenService: jest.Mocked<
    Pick<
      TokenService,
      'generateAccessToken' | 'issueRefreshToken' | 'rotateRefreshToken' | 'revokeRefreshToken' | 'generateOpaqueToken'
    >
  >;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: AuthService;

  beforeEach(() => {
    usersRepository = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      markEmailVerified: jest.fn(),
      setPasswordResetToken: jest.fn(),
      resetPassword: jest.fn(),
      findByPasswordResetTokenHash: jest.fn(),
      findByEmailVerificationTokenHash: jest.fn(),
    };
    rolesRepository = { findByName: jest.fn() };
    refreshTokensRepository = { revokeAllForUser: jest.fn() };
    tokenService = {
      generateAccessToken: jest.fn().mockReturnValue('access-token'),
      issueRefreshToken: jest
        .fn()
        .mockResolvedValue({ raw: 'refresh-token', record: { id: 'rt-1', userId: 'user-1' } }),
      rotateRefreshToken: jest.fn(),
      revokeRefreshToken: jest.fn(),
      generateOpaqueToken: jest.fn().mockReturnValue({ raw: 'raw-token', hash: 'token-hash' }),
    };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new AuthService(
      usersRepository as unknown as UsersRepository,
      rolesRepository as unknown as RolesRepository,
      refreshTokensRepository as unknown as RefreshTokensRepository,
      tokenService as unknown as TokenService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('register', () => {
    it('creates a new user with a hashed password and verification token', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      rolesRepository.findByName.mockResolvedValue({
        id: 'role-1',
        name: RoleName.CUSTOMER,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const createdUser = buildUser({ status: UserStatus.PENDING_VERIFICATION });
      usersRepository.create.mockResolvedValue(createdUser);

      const result = await service.register({
        email: 'jane@example.com',
        password: 'StrongPass1',
        confirmPassword: 'StrongPass1',
        firstName: 'Jane',
        lastName: 'Doe',
      });

      expect(result.emailVerificationToken).toBe('raw-token');
      expect(result.user.email).toBe('jane@example.com');
      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jane@example.com', roleId: 'role-1' }),
      );
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'registration.confirmed',
        expect.objectContaining({ userId: createdUser.id, firstName: 'Jane' }),
      );
    });

    it('rejects registration for an existing email', async () => {
      usersRepository.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.register({
          email: 'jane@example.com',
          password: 'StrongPass1',
          confirmPassword: 'StrongPass1',
          firstName: 'Jane',
          lastName: 'Doe',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws when the requested role is not seeded', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);
      rolesRepository.findByName.mockResolvedValue(null);

      await expect(
        service.register({
          email: 'jane@example.com',
          password: 'StrongPass1',
          confirmPassword: 'StrongPass1',
          firstName: 'Jane',
          lastName: 'Doe',
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('login', () => {
    it('returns a session for valid credentials', async () => {
      const passwordHash = await bcrypt.hash('StrongPass1', 4);
      usersRepository.findByEmail.mockResolvedValue(buildUser({ passwordHash }));

      const session = await service.login({ email: 'jane@example.com', password: 'StrongPass1' });

      expect(session.accessToken).toBe('access-token');
      expect(session.refreshToken).toBe('refresh-token');
      expect(session.user.roles).toEqual([RoleName.CUSTOMER]);
    });

    it('rejects an unknown email', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'missing@example.com', password: 'whatever' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a suspended account', async () => {
      usersRepository.findByEmail.mockResolvedValue(buildUser({ status: UserStatus.SUSPENDED }));

      await expect(
        service.login({ email: 'jane@example.com', password: 'whatever' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an incorrect password', async () => {
      const passwordHash = await bcrypt.hash('StrongPass1', 4);
      usersRepository.findByEmail.mockResolvedValue(buildUser({ passwordHash }));

      await expect(
        service.login({ email: 'jane@example.com', password: 'WrongPass1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token', async () => {
      await service.logout('refresh-token');
      expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith('refresh-token');
    });
  });

  describe('refresh', () => {
    it('rotates the token and returns a fresh session', async () => {
      tokenService.rotateRefreshToken.mockResolvedValue({
        raw: 'new-refresh-token',
        record: { id: 'rt-2', userId: 'user-1' } as never,
      });
      usersRepository.findById.mockResolvedValue(buildUser());

      const session = await service.refresh('old-refresh-token');

      expect(session.refreshToken).toBe('new-refresh-token');
      expect(session.accessToken).toBe('access-token');
    });

    it('throws when the account behind the token no longer exists', async () => {
      tokenService.rotateRefreshToken.mockResolvedValue({
        raw: 'new-refresh-token',
        record: { id: 'rt-2', userId: 'ghost' } as never,
      });
      usersRepository.findById.mockResolvedValue(null);

      await expect(service.refresh('old-refresh-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('forgotPassword', () => {
    it('sets a reset token when the user exists', async () => {
      usersRepository.findByEmail.mockResolvedValue(buildUser());

      await service.forgotPassword({ email: 'jane@example.com' });

      expect(usersRepository.setPasswordResetToken).toHaveBeenCalledWith(
        'user-1',
        'token-hash',
        expect.any(Date),
      );
    });

    it('does nothing when the user does not exist (avoids enumeration)', async () => {
      usersRepository.findByEmail.mockResolvedValue(null);

      await service.forgotPassword({ email: 'missing@example.com' });

      expect(usersRepository.setPasswordResetToken).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('resets the password and revokes existing sessions for a valid token', async () => {
      usersRepository.findByPasswordResetTokenHash.mockResolvedValue(
        buildUser({ passwordResetTokenExpiresAt: new Date(Date.now() + 60_000) }),
      );

      await service.resetPassword({
        token: 'raw-token',
        newPassword: 'NewStrongPass1',
        confirmPassword: 'NewStrongPass1',
      });

      expect(usersRepository.resetPassword).toHaveBeenCalledWith('user-1', expect.any(String));
      expect(refreshTokensRepository.revokeAllForUser).toHaveBeenCalledWith('user-1');
    });

    it('rejects an expired token', async () => {
      usersRepository.findByPasswordResetTokenHash.mockResolvedValue(
        buildUser({ passwordResetTokenExpiresAt: new Date(Date.now() - 60_000) }),
      );

      await expect(
        service.resetPassword({
          token: 'raw-token',
          newPassword: 'NewStrongPass1',
          confirmPassword: 'NewStrongPass1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown token', async () => {
      usersRepository.findByPasswordResetTokenHash.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          token: 'raw-token',
          newPassword: 'NewStrongPass1',
          confirmPassword: 'NewStrongPass1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verifyEmail', () => {
    it('marks the account verified for a valid token', async () => {
      usersRepository.findByEmailVerificationTokenHash.mockResolvedValue(
        buildUser({ emailVerificationTokenExpiresAt: new Date(Date.now() + 60_000) }),
      );

      await service.verifyEmail({ token: 'raw-token' });

      expect(usersRepository.markEmailVerified).toHaveBeenCalledWith('user-1');
    });

    it('rejects an expired token', async () => {
      usersRepository.findByEmailVerificationTokenHash.mockResolvedValue(
        buildUser({ emailVerificationTokenExpiresAt: new Date(Date.now() - 60_000) }),
      );

      await expect(service.verifyEmail({ token: 'raw-token' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an unknown token', async () => {
      usersRepository.findByEmailVerificationTokenHash.mockResolvedValue(null);

      await expect(service.verifyEmail({ token: 'raw-token' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
