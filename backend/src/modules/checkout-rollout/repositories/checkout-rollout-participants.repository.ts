import { Injectable } from '@nestjs/common';
import { CheckoutRolloutParticipant } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { AppendParticipationResult, SetParticipationInput } from '../types/checkout-rollout.types';

@Injectable()
export class CheckoutRolloutParticipantsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(customerId: string): Promise<CheckoutRolloutParticipant | null> {
    return this.prisma.checkoutRolloutParticipant.findFirst({
      where: { customerId },
      orderBy: { revision: 'desc' },
    });
  }

  listHistory(
    customerId: string,
    afterRevision = 0,
    limit = 50,
  ): Promise<CheckoutRolloutParticipant[]> {
    return this.prisma.checkoutRolloutParticipant.findMany({
      where: { customerId, revision: { gt: afterRevision } },
      orderBy: { revision: 'asc' },
      take: limit,
    });
  }

  // This is the only mutation API: no update/delete of historical revisions.
  // Actor/customer come from trusted server context, never a spread request body.
  appendIfCurrent(
    customerId: string,
    actorId: string,
    input: SetParticipationInput,
  ): Promise<AppendParticipationResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const lockKey = `checkout_rollout_participant:${customerId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const current = await tx.checkoutRolloutParticipant.findFirst({
          where: { customerId },
          orderBy: { revision: 'desc' },
        });
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== input.expectedRevision) {
          return { ok: false, code: 'STALE_REVISION', currentRevision };
        }
        if (!(await tx.user.findUnique({ where: { id: customerId }, select: { id: true } }))) {
          return { ok: false, code: 'CUSTOMER_NOT_FOUND' };
        }
        if (!(await tx.user.findUnique({ where: { id: actorId }, select: { id: true } }))) {
          return { ok: false, code: 'ACTOR_NOT_FOUND' };
        }
        const participant = await tx.checkoutRolloutParticipant.create({
          data: {
            customerId,
            actorId,
            enabled: input.enabled,
            cohort: input.cohort,
            reason: input.reason,
            revision: (currentRevision ?? 0) + 1,
          },
        });
        return { ok: true, participant };
      },
      { isolationLevel: 'ReadCommitted', timeout: 5000 },
    );
  }
}
