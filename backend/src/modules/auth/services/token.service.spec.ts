import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken } from '@prisma/client';

import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { parseDurationToMs, parseDurationToSeconds, TokenService } from './token.service';

describe('parseDurationToMs / parseDurationToSeconds', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('parses %s to %dms', (input, expected) => {
    expect(parseDurationToMs(input)).toBe(expected);
  });

  it('converts to whole seconds', () => {
    expect(parseDurationToSeconds('1m')).toBe(60);
  });

  it('throws on an invalid format', () => {
    expect(() => parseDurationToMs('nonsense')).toThrow('Invalid duration format: nonsense');
  });
});

describe('TokenService', () => {
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let configService: { getOrThrow: jest.Mock<string, [string]> };
  let refreshTokensRepository: jest.Mocked<
    Pick<RefreshTokensRepository, 'create' | 'findValidByTokenHash' | 'revoke'>
  >;
  let service: TokenService;

  const fakeRefreshToken: RefreshToken = {
    id: 'rt-1',
    userId: 'user-1',
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    jwtService = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
    configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'JWT_ACCESS_SECRET') return 'access-secret';
        if (key === 'JWT_ACCESS_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        throw new Error(`unexpected key ${key}`);
      }),
    };
    refreshTokensRepository = {
      create: jest.fn(),
      findValidByTokenHash: jest.fn(),
      revoke: jest.fn(),
    };

    service = new TokenService(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
      refreshTokensRepository as unknown as RefreshTokensRepository,
    );
  });

  it('generates a signed access token', () => {
    const token = service.generateAccessToken({
      sub: 'user-1',
      email: 'a@b.com',
      roles: ['CUSTOMER'],
    });

    expect(token).toBe('signed.jwt.token');
    expect(jwtService.sign).toHaveBeenCalledWith(
      { sub: 'user-1', email: 'a@b.com', roles: ['CUSTOMER'] },
      { secret: 'access-secret', expiresIn: 900 },
    );
  });

  it('issues and persists a refresh token', async () => {
    refreshTokensRepository.create.mockResolvedValue(fakeRefreshToken);

    const issued = await service.issueRefreshToken('user-1');

    expect(issued.raw).toHaveLength(128);
    expect(refreshTokensRepository.create).toHaveBeenCalledWith(
      'user-1',
      TokenService.hash(issued.raw),
      expect.any(Date),
    );
    expect(issued.record).toBe(fakeRefreshToken);
  });

  it('rotates a valid refresh token', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(fakeRefreshToken);
    refreshTokensRepository.create.mockResolvedValue(fakeRefreshToken);

    const rotated = await service.rotateRefreshToken('raw-token');

    expect(refreshTokensRepository.revoke).toHaveBeenCalledWith(fakeRefreshToken.id);
    expect(refreshTokensRepository.create).toHaveBeenCalledWith(
      fakeRefreshToken.userId,
      expect.any(String),
      expect.any(Date),
    );
    expect(rotated.record).toBe(fakeRefreshToken);
  });

  it('throws when rotating an invalid refresh token', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(null);

    await expect(service.rotateRefreshToken('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('verifies a valid refresh token', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(fakeRefreshToken);

    await expect(service.verifyRefreshToken('raw-token')).resolves.toBe(fakeRefreshToken);
  });

  it('throws when verifying an invalid refresh token', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(null);

    await expect(service.verifyRefreshToken('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('revokes a refresh token when it exists', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(fakeRefreshToken);

    await service.revokeRefreshToken('raw-token');

    expect(refreshTokensRepository.revoke).toHaveBeenCalledWith(fakeRefreshToken.id);
  });

  it('does nothing when revoking a token that does not exist', async () => {
    refreshTokensRepository.findValidByTokenHash.mockResolvedValue(null);

    await service.revokeRefreshToken('bad-token');

    expect(refreshTokensRepository.revoke).not.toHaveBeenCalled();
  });

  it('generates an opaque token with a matching hash', () => {
    const { raw, hash } = service.generateOpaqueToken();

    expect(raw).toHaveLength(64);
    expect(hash).toBe(TokenService.hash(raw));
  });
});
