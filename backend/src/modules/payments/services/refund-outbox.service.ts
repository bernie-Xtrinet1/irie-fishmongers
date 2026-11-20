import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  RefundOutboxConsumer,
  RefundOutboxDispatchResult,
  RefundOutboxPolicy,
  RefundOutboxRecord,
} from '../types/refund-reconciliation.types';

const REFUND_AGGREGATE_TYPES = ['Refund', 'RefundObligation'] as const;

const DEFAULT_REFUND_OUTBOX_POLICY: RefundOutboxPolicy = {
  allowNotificationDispatch: false,
};

interface LockedOutboxRow {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
  published: boolean;
  createdAt: Date;
}

/**
 * Internal idempotent outbox dispatcher contract for refund ledger events.
 * Fails closed (allowNotificationDispatch=false by default) so notifications are
 * never automatically emitted in production until explicitly authorized.
 */
@Injectable()
export class RefundOutboxService {
  private readonly policy: RefundOutboxPolicy;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() policy?: Partial<RefundOutboxPolicy>,
  ) {
    this.policy = {
      allowNotificationDispatch:
        policy?.allowNotificationDispatch ?? DEFAULT_REFUND_OUTBOX_POLICY.allowNotificationDispatch,
    };
  }

  async listPendingRefundEvents(limit = 50): Promise<RefundOutboxRecord[]> {
    const rows = await this.prisma.paymentOutbox.findMany({
      where: {
        published: false,
        aggregateType: { in: [...REFUND_AGGREGATE_TYPES] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    return rows.map((row) => this.toOutboxRecord(row));
  }

  async dispatchPendingRefundEvents(
    consumer?: RefundOutboxConsumer,
    options?: { limit?: number; policyOverride?: Partial<RefundOutboxPolicy> },
  ): Promise<RefundOutboxDispatchResult> {
    const allowDispatch =
      options?.policyOverride?.allowNotificationDispatch ?? this.policy.allowNotificationDispatch;

    const candidates = await this.prisma.paymentOutbox.findMany({
      where: {
        published: false,
        aggregateType: { in: [...REFUND_AGGREGATE_TYPES] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: options?.limit ?? 50,
      select: { id: true },
    });

    if (!allowDispatch || !consumer) {
      return {
        fetchedCount: candidates.length,
        publishedIds: [],
        skippedAlreadyPublishedIds: [],
        failed: [],
      };
    }

    const publishedIds: string[] = [];
    const skippedAlreadyPublishedIds: string[] = [];
    const failed: Array<{ outboxId: string; logicalEventKey: string; message: string }> = [];

    for (const candidate of candidates) {
      let currentKey = `refund_outbox:unknown:${candidate.id}`;
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<LockedOutboxRow[]>(
              Prisma.sql`
                SELECT "id", "aggregateId", "aggregateType", "eventType", "payload", "published", "createdAt"
                FROM "payment_outbox"
                WHERE "id" = ${candidate.id}
                FOR UPDATE
              `,
            );

            const row = rows[0];
            if (!row) {
              return { status: 'MISSING' as const };
            }

            if (row.published) {
              return { status: 'ALREADY_PUBLISHED' as const };
            }

            const record = this.toOutboxRecord(row);
            currentKey = record.logicalEventKey;

            // Invoke consumer BEFORE committing published=true so a crash or lost
            // ACK preserves published=false for safe retry with same logicalEventKey.
            await consumer(record);

            await tx.paymentOutbox.update({
              where: { id: row.id },
              data: {
                published: true,
                publishedAt: new Date(),
              },
            });

            return { status: 'PUBLISHED' as const };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 10_000,
            timeout: 10_000,
          },
        );

        if (result.status === 'PUBLISHED') {
          publishedIds.push(candidate.id);
        } else if (result.status === 'ALREADY_PUBLISHED') {
          skippedAlreadyPublishedIds.push(candidate.id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({
          outboxId: candidate.id,
          logicalEventKey: currentKey,
          message,
        });
      }
    }

    return {
      fetchedCount: candidates.length,
      publishedIds,
      skippedAlreadyPublishedIds,
      failed,
    };
  }

  private toOutboxRecord(row: LockedOutboxRow): RefundOutboxRecord {
    const rawPayload =
      row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const existingKey = rawPayload['logicalEventKey'];
    const logicalEventKey =
      typeof existingKey === 'string' && existingKey.trim().length > 0
        ? existingKey.trim()
        : `refund_outbox:${row.eventType}:${row.aggregateId}:${row.id}`;

    return {
      id: row.id,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
      eventType: row.eventType,
      logicalEventKey,
      payload: rawPayload,
      createdAt: row.createdAt,
    };
  }
}
