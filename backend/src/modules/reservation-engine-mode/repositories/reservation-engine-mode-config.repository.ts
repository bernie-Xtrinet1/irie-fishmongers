import { Injectable } from '@nestjs/common';
import { Prisma, ReservationEngineMode, ReservationEngineModeConfig } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

export type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export interface CreateReservationEngineModeConfigInput {
  mode: ReservationEngineMode;
  updatedById: string;
}

// Persistence only - no business rules (see ADR-007 Decision 8). Mirrors
// MarketplaceModeConfigsRepository exactly: append-only, "current" is
// always the most recently created row. The DRAINING -> LEGACY rollback
// gate, and the advisory-lock-serialized read-validate-write sequence
// that closes the concurrent-mode-change race, are both enforced by
// ReservationEngineModeService before/around this class being asked to
// create a row - this repository has no way to enforce either itself, by
// design. Both methods accept an optional trailing transaction client
// (matching CartRepository/ProductsRepository's established convention)
// so the service can run findCurrent + create inside the same advisory-
// locked transaction.
@Injectable()
export class ReservationEngineModeConfigRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCurrent(client: PrismaClientOrTx = this.prisma): Promise<ReservationEngineModeConfig | null> {
    return client.reservationEngineModeConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  create(
    input: CreateReservationEngineModeConfigInput,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<ReservationEngineModeConfig> {
    return client.reservationEngineModeConfig.create({ data: input });
  }
}
