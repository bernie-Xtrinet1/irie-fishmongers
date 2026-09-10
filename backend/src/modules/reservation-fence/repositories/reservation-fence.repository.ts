import { Injectable } from '@nestjs/common';
import { Prisma, ReservationFenceTransition } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { FenceTuple } from '../types/reservation-fence.types';

export function transitionTuple(row: ReservationFenceTransition): FenceTuple {
  return { incarnation: row.incarnation, epoch: row.epoch, revision: row.revision,
    phase: row.phase, protocol: row.protocol, transitionId: row.id };
}

@Injectable()
export class ReservationFenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Dedicated two-int namespace; does not alias the checkout recovery lock.
  // Also shares the existing mode lock so an actual mode change cannot cross
  // a check/ack/capability write. No import of the mode or inventory modules.
  async locked<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1380339280, 1)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('reservation_engine_mode_transition'))`;
      return work(tx);
    }, { timeout: 5000 });
  }

  latest(tx: Prisma.TransactionClient) {
    return tx.reservationFenceTransition.findFirst({ orderBy: { revision: 'desc' } });
  }

  async mode(tx: Prisma.TransactionClient) {
    const row = await tx.reservationEngineModeConfig.findFirst({ orderBy: { revision: 'desc' } });
    return { mode: row?.mode ?? 'LEGACY', modeRevision: row?.revision ?? null } as const;
  }

  insert(tx: Prisma.TransactionClient, data: Prisma.ReservationFenceTransitionCreateInput) {
    return tx.reservationFenceTransition.create({ data });
  }

  acknowledge(tx: Prisma.TransactionClient, id: string) {
    return tx.reservationFenceTransition.update({ where: { id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
  }
}
