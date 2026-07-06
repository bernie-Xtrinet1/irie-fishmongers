import * as bcrypt from 'bcrypt';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { RoleName } from '@prisma/client';

import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RegisterDto } from '../dto/register.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { UserResponseEntity } from '../entities/user-response.entity';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { RolesRepository } from '../repositories/roles.repository';
import { UsersRepository, UserWithRoles } from '../repositories/users.repository';
import { TokenService } from './token.service';

const BCRYPT_SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  user: UserResponseEntity;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly rolesRepository: RolesRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly tokenService: TokenService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ user: UserResponseEntity; emailVerificationToken: string }> {
    const existing = await this.usersRepository.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const roleName = dto.role ?? RoleName.CUSTOMER;
    const role = await this.rolesRepository.findByName(roleName);
    if (!role) {
      throw new InternalServerErrorException(`Role ${roleName} is not configured`);
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const { raw: emailVerificationToken, hash: emailVerificationTokenHash } =
      this.tokenService.generateOpaqueToken();

    const user = await this.usersRepository.create({
      email: dto.email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      roleId: role.id,
      emailVerificationTokenHash,
      emailVerificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });

    return { user: AuthService.toUserResponse(user), emailVerificationToken };
  }

  async login(dto: LoginDto): Promise<AuthenticatedSession> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
      throw new ForbiddenException('This account is not permitted to sign in');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueSession(user);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(rawRefreshToken);
  }

  async refresh(rawRefreshToken: string): Promise<AuthenticatedSession> {
    const rotated = await this.tokenService.rotateRefreshToken(rawRefreshToken);
    const user = await this.usersRepository.findById(rotated.record.userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const accessToken = this.tokenService.generateAccessToken({
      sub: user.id,
      email: user.email,
      roles: UsersRepository.toRoleNames(user),
    });

    return {
      accessToken,
      refreshToken: rotated.raw,
      user: AuthService.toUserResponse(user),
    };
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user || user.status === 'DEACTIVATED') {
      return;
    }

    const { hash } = this.tokenService.generateOpaqueToken();
    await this.usersRepository.setPasswordResetToken(
      user.id,
      hash,
      new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = TokenService.hash(dto.token);
    const user = await this.usersRepository.findByPasswordResetTokenHash(tokenHash);

    if (
      !user ||
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_SALT_ROUNDS);
    await this.usersRepository.resetPassword(user.id, passwordHash);
    await this.refreshTokensRepository.revokeAllForUser(user.id);
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const tokenHash = TokenService.hash(dto.token);
    const user = await this.usersRepository.findByEmailVerificationTokenHash(tokenHash);

    if (
      !user ||
      !user.emailVerificationTokenExpiresAt ||
      user.emailVerificationTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Invalid or expired email verification token');
    }

    await this.usersRepository.markEmailVerified(user.id);
  }

  private async issueSession(user: UserWithRoles): Promise<AuthenticatedSession> {
    const accessToken = this.tokenService.generateAccessToken({
      sub: user.id,
      email: user.email,
      roles: UsersRepository.toRoleNames(user),
    });
    const { raw: refreshToken } = await this.tokenService.issueRefreshToken(user.id);

    return { accessToken, refreshToken, user: AuthService.toUserResponse(user) };
  }

  private static toUserResponse(user: UserWithRoles): UserResponseEntity {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      status: user.status,
      roles: UsersRepository.toRoleNames(user),
      createdAt: user.createdAt,
    };
  }
}
