import { Injectable } from '@nestjs/common';
import { Prisma, ReviewAuditLog } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export interface CreateReviewAuditLogInput {
  reviewId: string;
  actorId: string;
  action: string;
  beforeValue?: Prisma.InputJsonValue;
  afterValue?: Prisma.InputJsonValue;
  reason?: string;
  ipAddress?: string;
}

@Injectable()
export class ReviewAuditLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Builds the audit-insert operation WITHOUT executing it, so the caller
  // can run it inside the same prisma.$transaction as the moderation
  // update - the audit record is part of the moderation action's integrity,
  // not fire-and-forget telemetry (Phase 13B).
  buildCreate(input: CreateReviewAuditLogInput): Prisma.PrismaPromise<ReviewAuditLog> {
    return this.prisma.reviewAuditLog.create({ data: input });
  }

  findByReviewId(reviewId: string): Promise<ReviewAuditLog[]> {
    return this.prisma.reviewAuditLog.findMany({
      where: { reviewId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
