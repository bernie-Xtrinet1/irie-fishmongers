import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { REFRESH_TOKEN_COOKIE_NAME, REFRESH_TOKEN_COOKIE_PATH } from '../constants/auth.constants';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RegisterDto } from '../dto/register.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { AuthTokensEntity } from '../entities/auth-tokens.entity';
import { UserResponseEntity } from '../entities/user-response.entity';
import { AuthenticatedSession, AuthService } from '../services/auth.service';
import { parseDurationToMs } from '../services/token.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new customer, vendor, or driver account' })
  @ApiResponseDoc({ status: 201, type: UserResponseEntity })
  async register(@Body() dto: RegisterDto): Promise<UserResponseEntity> {
    const { user } = await this.authService.register(dto);
    return user;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiResponseDoc({ status: 200, type: AuthTokensEntity })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensEntity> {
    const session = await this.authService.login(dto);
    this.setRefreshTokenCookie(res, session.refreshToken);
    return session;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current refresh token' })
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    const refreshToken = this.extractRefreshToken(req, dto);
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    this.clearRefreshTokenCookie(res);
    return { success: true };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a valid refresh token for a new token pair' })
  @ApiResponseDoc({ status: 200, type: AuthTokensEntity })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokensEntity> {
    const refreshToken = this.extractRefreshToken(req, dto);
    if (!refreshToken) {
      this.clearRefreshTokenCookie(res);
      throw new UnauthorizedException('Refresh token is required');
    }

    const session: AuthenticatedSession = await this.authService.refresh(refreshToken);
    this.setRefreshTokenCookie(res, session.refreshToken);
    return session;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a password reset token for the given email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ success: true }> {
    await this.authService.forgotPassword(dto);
    return { success: true };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reset a password using a valid reset token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ success: true }> {
    await this.authService.resetPassword(dto);
    return { success: true };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an account email using the token issued at registration' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ success: true }> {
    await this.authService.verifyEmail(dto);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the currently authenticated user' })
  me(@CurrentUser() user: RequestUser): RequestUser {
    return user;
  }

  private extractRefreshToken(req: Request, dto: RefreshTokenDto): string | undefined {
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_TOKEN_COOKIE_NAME
    ];
    return cookieToken ?? dto.refreshToken;
  }

  private setRefreshTokenCookie(res: Response, refreshToken: string): void {
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    const maxAge = parseDurationToMs(
      this.configService.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN'),
    );

    res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: REFRESH_TOKEN_COOKIE_PATH,
      maxAge,
    });
  }

  private clearRefreshTokenCookie(res: Response): void {
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
  }
}
