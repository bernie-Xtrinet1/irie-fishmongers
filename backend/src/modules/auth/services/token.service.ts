import { randomBytes, createHash } from 'crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken, RoleName } from '@prisma/client';

import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: RoleName[];
}

export interface IssuedRefreshToken {
  raw: string;
  record: RefreshToken;
}

const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationToMs(duration: string): number {
  const match = DURATION_PATTERN.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  const [, amount, unit] = match as unknown as [string, string, keyof typeof UNIT_TO_MS];
  return Number(amount) * UNIT_TO_MS[unit]!;
}

export function parseDurationToSeconds(duration: string): number {
  return Math.floor(parseDurationToMs(duration) / 1_000);
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
  ) {}

  generateAccessToken(payload: AccessTokenPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: parseDurationToSeconds(
        this.configService.getOrThrow<string>('JWT_ACCESS_EXPIRES_IN'),
      ),
    });
  }

  async issueRefreshToken(userId: string): Promise<IssuedRefreshToken> {
    const raw = randomBytes(64).toString('hex');
    const tokenHash = TokenService.hash(raw);
    const expiresIn = this.configService.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN');
    const expiresAt = new Date(Date.now() + parseDurationToMs(expiresIn));

    const record = await this.refreshTokensRepository.create(userId, tokenHash, expiresAt);
    return { raw, record };
  }

  async rotateRefreshToken(rawToken: string): Promise<IssuedRefreshToken> {
    const existing = await this.refreshTokensRepository.findValidByTokenHash(
      TokenService.hash(rawToken),
    );
    if (!existing) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.refreshTokensRepository.revoke(existing.id);
    return this.issueRefreshToken(existing.userId);
  }

  async verifyRefreshToken(rawToken: string): Promise<RefreshToken> {
    const existing = await this.refreshTokensRepository.findValidByTokenHash(
      TokenService.hash(rawToken),
    );
    if (!existing) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return existing;
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    const existing = await this.refreshTokensRepository.findValidByTokenHash(
      TokenService.hash(rawToken),
    );
    if (existing) {
      await this.refreshTokensRepository.revoke(existing.id);
    }
  }

  generateOpaqueToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('hex');
    return { raw, hash: TokenService.hash(raw) };
  }

  static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
