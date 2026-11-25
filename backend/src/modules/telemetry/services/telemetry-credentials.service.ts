import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TelemetryCredentialScope } from '@prisma/client';
import { randomBytes } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';
import { IssueTelemetryCredentialDto } from '../dto/telemetry.dto';
import { hashTelemetryToken } from '../guards/telemetry-gateway-auth.guard';

export interface SafeTelemetryCredentialView {
  id: string;
  scope: TelemetryCredentialScope;
  trackerId: string | null;
  label: string;
  keyPrefix: string;
  active: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface IssuedTelemetryCredentialResult {
  credential: SafeTelemetryCredentialView;
  /** Returned strictly once on issuance/rotation; only secretHash is persisted. */
  plaintextSecret: string;
  rotatedOutCredentialId?: string;
}

const SAFE_CREDENTIAL_SELECT = {
  id: true,
  scope: true,
  trackerId: true,
  label: true,
  keyPrefix: true,
  active: true,
  expiresAt: true,
  revokedAt: true,
  revokedReason: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class TelemetryCredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  private static generateRawSecret(): { rawSecret: string; keyPrefix: string; secretHash: string } {
    const rawSecret = `itg_${randomBytes(24).toString('base64url')}`;
    return {
      rawSecret,
      keyPrefix: rawSecret.slice(0, 12),
      secretHash: hashTelemetryToken(rawSecret),
    };
  }

  async issue(
    actorUserId: string,
    dto: IssueTelemetryCredentialDto,
  ): Promise<IssuedTelemetryCredentialResult> {
    const scope = dto.scope ?? TelemetryCredentialScope.DEVICE_TRACKER;

    if (scope === TelemetryCredentialScope.DEVICE_TRACKER) {
      if (!dto.trackerId) {
        throw new BadRequestException('trackerId is required for DEVICE_TRACKER credentials');
      }
      const tracker = await this.prisma.vehicleTracker.findUnique({
        where: { id: dto.trackerId },
        select: { id: true },
      });
      if (!tracker) {
        throw new NotFoundException('Vehicle tracker not found');
      }
    }

    const { rawSecret, keyPrefix, secretHash } = TelemetryCredentialsService.generateRawSecret();
    const expiresAt = dto.expiresInHours
      ? new Date(Date.now() + dto.expiresInHours * 3600_000)
      : null;

    const credential = await this.prisma.telemetryDeviceCredential.create({
      data: {
        scope,
        trackerId: scope === TelemetryCredentialScope.DEVICE_TRACKER ? dto.trackerId! : null,
        label: dto.label.trim(),
        keyPrefix,
        secretHash,
        active: true,
        expiresAt,
        createdById: actorUserId,
      },
      select: SAFE_CREDENTIAL_SELECT,
    });

    return {
      credential,
      plaintextSecret: rawSecret,
    };
  }

  async rotate(
    actorUserId: string,
    credentialId: string,
    graceMinutes = 60,
  ): Promise<IssuedTelemetryCredentialResult> {
    const existing = await this.prisma.telemetryDeviceCredential.findUnique({
      where: { id: credentialId },
    });

    if (!existing) {
      throw new NotFoundException('Telemetry credential not found');
    }
    if (!existing.active || existing.revokedAt) {
      throw new BadRequestException('Cannot rotate an already revoked credential');
    }

    const now = new Date();
    const { rawSecret, keyPrefix, secretHash } = TelemetryCredentialsService.generateRawSecret();

    const newCredential = await this.prisma.$transaction(async (tx) => {
      if (graceMinutes === 0) {
        await tx.telemetryDeviceCredential.update({
          where: { id: existing.id },
          data: {
            active: false,
            revokedAt: now,
            revokedById: actorUserId,
            revokedReason: 'Rotated immediately',
          },
        });
      } else {
        const overlapExpiresAt = new Date(now.getTime() + graceMinutes * 60_000);
        const effectiveExpiry =
          existing.expiresAt && existing.expiresAt.getTime() < overlapExpiresAt.getTime()
            ? existing.expiresAt
            : overlapExpiresAt;
        await tx.telemetryDeviceCredential.update({
          where: { id: existing.id },
          data: { expiresAt: effectiveExpiry },
        });
      }

      return tx.telemetryDeviceCredential.create({
        data: {
          scope: existing.scope,
          trackerId: existing.trackerId,
          label: existing.label,
          keyPrefix,
          secretHash,
          active: true,
          createdById: actorUserId,
        },
        select: SAFE_CREDENTIAL_SELECT,
      });
    });

    return {
      credential: newCredential,
      plaintextSecret: rawSecret,
      rotatedOutCredentialId: existing.id,
    };
  }

  async revoke(
    actorUserId: string,
    credentialId: string,
    reason?: string,
  ): Promise<SafeTelemetryCredentialView> {
    const existing = await this.prisma.telemetryDeviceCredential.findUnique({
      where: { id: credentialId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) {
      throw new NotFoundException('Telemetry credential not found');
    }

    return this.prisma.telemetryDeviceCredential.update({
      where: { id: credentialId },
      data: {
        active: false,
        revokedAt: existing.revokedAt ?? new Date(),
        revokedById: actorUserId,
        revokedReason: reason?.trim() || 'Revoked by administrator',
      },
      select: SAFE_CREDENTIAL_SELECT,
    });
  }

  list(trackerId?: string): Promise<SafeTelemetryCredentialView[]> {
    return this.prisma.telemetryDeviceCredential.findMany({
      where: trackerId ? { trackerId } : undefined,
      select: SAFE_CREDENTIAL_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }
}
