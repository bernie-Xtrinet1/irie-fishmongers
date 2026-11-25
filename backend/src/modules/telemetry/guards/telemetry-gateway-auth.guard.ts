import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DeviceStatus, TelemetryCredentialScope } from '@prisma/client';
import { createHash } from 'crypto';
import { Request } from 'express';

import { PrismaService } from '../../../database/prisma.service';

export interface TelemetryAuthContext {
  credentialId: string;
  scope: TelemetryCredentialScope;
  trackerId: string | null;
  trackerImei: string | null;
}

export interface TelemetryAuthenticatedRequest extends Request {
  telemetryAuth?: TelemetryAuthContext;
}

export function hashTelemetryToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class TelemetryGatewayAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TelemetryAuthenticatedRequest>();
    const rawToken = this.extractDeviceToken(request);

    if (!rawToken) {
      throw new UnauthorizedException('Missing device or gateway telemetry credential');
    }

    const secretHash = hashTelemetryToken(rawToken);
    const credential = await this.prisma.telemetryDeviceCredential.findUnique({
      where: { secretHash },
      include: {
        tracker: {
          select: {
            id: true,
            imei: true,
            status: true,
          },
        },
      },
    });

    if (!credential || !credential.active || credential.revokedAt) {
      throw new UnauthorizedException('Invalid or revoked telemetry credential');
    }

    if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Telemetry credential rotation window has expired');
    }

    if (credential.scope === TelemetryCredentialScope.DEVICE_TRACKER) {
      if (!credential.tracker || credential.tracker.status !== DeviceStatus.ACTIVE) {
        throw new UnauthorizedException('Associated tracker is inactive or missing');
      }
    }

    request.telemetryAuth = {
      credentialId: credential.id,
      scope: credential.scope,
      trackerId: credential.tracker?.id ?? null,
      trackerImei: credential.tracker?.imei ?? null,
    };

    // Best-effort heartbeat timestamp update without failing ingestion if contended.
    if (typeof this.prisma.telemetryDeviceCredential.update === 'function') {
      void this.prisma.telemetryDeviceCredential
        .update({
          where: { id: credential.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => undefined);
    }

    return true;
  }

  private extractDeviceToken(request: Request): string | null {
    const headerKey = request.headers['x-telemetry-key'];
    if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
      return headerKey.trim();
    }

    const authHeader = request.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
      const [scheme, token] = authHeader.trim().split(/\s+/);
      if (scheme?.toLowerCase() === 'bearer') {
        throw new UnauthorizedException(
          'User Bearer JWT tokens cannot be used on device telemetry endpoints; supply Device or X-Telemetry-Key credentials',
        );
      }
      if (scheme?.toLowerCase() === 'device' && token) {
        return token.trim();
      }
    }

    return null;
  }
}
