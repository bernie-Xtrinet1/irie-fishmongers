import { Injectable } from '@nestjs/common';
import { CheckoutRolloutControlRevision, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CreateRolloutControlDto } from '../dto/rollout-control.dto';

import { lockRolloutGlobal } from '../../checkout-rollout/checkout-rollout-locks';
export {
  ROLLOUT_CONTROL_LOCK_NAMESPACE,
  ROLLOUT_CONTROL_LOCK_ID,
} from '../../checkout-rollout/checkout-rollout-locks';

@Injectable()
export class RolloutControlsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CheckoutRolloutControlRevision | null> {
    return client.checkoutRolloutControlRevision.findFirst({ orderBy: { revision: 'desc' } });
  }

  listHistory(afterRevision: number, limit: number) {
    return this.prisma.checkoutRolloutControlRevision.findMany({
      where: { revision: { gt: afterRevision } },
      orderBy: { revision: 'asc' },
      take: limit,
    });
  }

  appendIfCurrent(actorId: string, input: CreateRolloutControlDto) {
    return this.prisma.$transaction(
      async (tx) => {
        await lockRolloutGlobal(tx, true);
        const current = await this.findCurrent(tx);
        if ((current?.revision ?? null) !== input.expectedRevision)
          return { ok: false as const, code: 'STALE_REVISION' as const };
        if (!(await tx.user.findUnique({ where: { id: actorId }, select: { id: true } })))
          return { ok: false as const, code: 'ACTOR_NOT_FOUND' as const };
        const control = await tx.checkoutRolloutControlRevision.create({
          data: {
            revision: (current?.revision ?? 0) + 1,
            actorId,
            newAdmissionStopped: input.newAdmissionStopped,
            behavior: input.behavior,
            eligibleCohort: input.eligibleCohort,
            reason: input.reason,
          },
        });
        return { ok: true as const, control };
      },
      { isolationLevel: 'ReadCommitted', timeout: 5000, maxWait: 5000 },
    );
  }
}
