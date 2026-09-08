import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { CreateRolloutControlDto } from '../dto/rollout-control.dto';

// Stable, separate two-int advisory namespace. G.3b must use this exact pair
// for its future shared admission lock; G.3a implements only exclusive writers.
export const ROLLOUT_CONTROL_LOCK_NAMESPACE = 1196634962;
export const ROLLOUT_CONTROL_LOCK_ID = 1;

@Injectable()
export class RolloutControlsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent() {
    return this.prisma.checkoutRolloutControlRevision.findFirst({ orderBy: { revision: 'desc' } });
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROLLOUT_CONTROL_LOCK_NAMESPACE}::integer, ${ROLLOUT_CONTROL_LOCK_ID}::integer)`;
        const current = await tx.checkoutRolloutControlRevision.findFirst({
          orderBy: { revision: 'desc' },
        });
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
