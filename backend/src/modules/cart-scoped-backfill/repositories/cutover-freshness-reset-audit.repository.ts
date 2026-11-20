import { Injectable } from '@nestjs/common';
import { CutoverFreshnessResetAudit, Prisma } from '@prisma/client';
import { createHash } from 'crypto';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { PrismaService } from '../../../database/prisma.service';
import { PrismaClientOrTx } from '../../cart/repositories/cart.repository';

// Dedicated UUIDv5 namespace for deterministic idempotent FRESHNESS_SWEEP
// request identities per (cutoverRunId, barrierRevision, markerId, generation).
const FRESHNESS_REQUEST_NAMESPACE = Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex');
const FRESHNESS_REQUEST_PREFIX = 'iriefishmongers:cutover-freshness-reset:v1:';

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function deriveFreshnessRequestId(
  cutoverRunId: string,
  barrierRevision: number,
  markerId: string,
  generation: number,
): string {
  const bytes = createHash('sha1')
    .update(FRESHNESS_REQUEST_NAMESPACE)
    .update(`${FRESHNESS_REQUEST_PREFIX}${cutoverRunId}:${barrierRevision}:${markerId}:${generation}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeFailureCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return (normalized || 'UNKNOWN_FAILURE').slice(0, 64);
}

export interface CreatePreparedFreshnessResetInput {
  requestId: string;
  cutoverRunId: string;
  barrierRevision: number;
  fenceTransitionId: string;
  incarnation: string;
  fenceEpoch: number;
  fenceRevision: number;
  modeRevision: number;
  markerId: string;
  generation: number;
  holdInstanceId: string;
  customerId: string;
  cartId: string;
  productId: string;
  quantity: number;
  operatorId: string;
  reason: string;
  anchorNowMs: bigint;
}

export interface CompleteFreshnessResetInput {
  priorCreatedAtMs: bigint;
  priorLastRenewedAtMs: bigint | null;
  priorExpiresAtMs: bigint | null;
  priorAbsoluteExpiresAtMs: bigint;
  newCreatedAtMs: bigint;
  newLastRenewedAtMs: bigint;
  newExpiresAtMs: bigint;
  newAbsoluteExpiresAtMs: bigint;
  redisReceipt: string;
  redisReceiptHash: string;
}

@Injectable()
export class CutoverFreshnessResetAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string, client: PrismaClientOrTx = this.prisma): Promise<CutoverFreshnessResetAudit | null> {
    return client.cutoverFreshnessResetAudit.findUnique({ where: { id } });
  }

  findByRequestId(requestId: string, client: PrismaClientOrTx = this.prisma): Promise<CutoverFreshnessResetAudit | null> {
    return client.cutoverFreshnessResetAudit.findUnique({ where: { requestId } });
  }

  findByIdempotencyTuple(
    cutoverRunId: string,
    barrierRevision: number,
    markerId: string,
    generation: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CutoverFreshnessResetAudit | null> {
    return client.cutoverFreshnessResetAudit.findUnique({
      where: {
        cutoverRunId_barrierRevision_markerId_generation: {
          cutoverRunId,
          barrierRevision,
          markerId,
          generation,
        },
      },
    });
  }

  findInFlightForMarker(
    markerId: string,
    generation: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<CutoverFreshnessResetAudit | null> {
    return client.cutoverFreshnessResetAudit.findFirst({
      where: { markerId, generation, status: 'PREPARED' },
      orderBy: { createdAt: 'desc' },
    });
  }

  createPrepared(
    input: CreatePreparedFreshnessResetInput,
    client: Prisma.TransactionClient,
  ): Promise<CutoverFreshnessResetAudit> {
    return client.cutoverFreshnessResetAudit.create({
      data: {
        requestId: input.requestId,
        cutoverRunId: input.cutoverRunId,
        barrierRevision: input.barrierRevision,
        fenceTransitionId: input.fenceTransitionId,
        incarnation: input.incarnation,
        fenceEpoch: input.fenceEpoch,
        fenceRevision: input.fenceRevision,
        modeRevision: input.modeRevision,
        markerId: input.markerId,
        generation: input.generation,
        holdInstanceId: input.holdInstanceId,
        customerId: input.customerId,
        cartId: input.cartId,
        productId: input.productId,
        quantity: input.quantity,
        operatorId: input.operatorId,
        reason: input.reason,
        anchorNowMs: input.anchorNowMs,
      },
    });
  }

  async markCompleted(
    id: string,
    evidence: CompleteFreshnessResetInput,
  ): Promise<{ updatedCount: number; row: CutoverFreshnessResetAudit }> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.cutoverFreshnessResetAudit.updateMany({
        where: { id, status: 'PREPARED' },
        data: {
          status: 'COMPLETED',
          priorCreatedAtMs: evidence.priorCreatedAtMs,
          priorLastRenewedAtMs: evidence.priorLastRenewedAtMs,
          priorExpiresAtMs: evidence.priorExpiresAtMs,
          priorAbsoluteExpiresAtMs: evidence.priorAbsoluteExpiresAtMs,
          newCreatedAtMs: evidence.newCreatedAtMs,
          newLastRenewedAtMs: evidence.newLastRenewedAtMs,
          newExpiresAtMs: evidence.newExpiresAtMs,
          newAbsoluteExpiresAtMs: evidence.newAbsoluteExpiresAtMs,
          redisReceipt: evidence.redisReceipt,
          redisReceiptHash: evidence.redisReceiptHash,
        },
      });
      const row = await tx.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { id } });
      return { updatedCount: updated.count, row };
    });
  }

  async markAborted(
    id: string,
    failureCode: string,
    failureDetail: string | null,
  ): Promise<{ updatedCount: number; row: CutoverFreshnessResetAudit }> {
    const code = normalizeFailureCode(failureCode);
    const detail = sanitizeErrorMessage(failureDetail, 500) ?? code;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.cutoverFreshnessResetAudit.updateMany({
        where: { id, status: 'PREPARED' },
        data: { status: 'ABORTED', failureCode: code, failureDetail: detail },
      });
      const row = await tx.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { id } });
      return { updatedCount: updated.count, row };
    });
  }
}
