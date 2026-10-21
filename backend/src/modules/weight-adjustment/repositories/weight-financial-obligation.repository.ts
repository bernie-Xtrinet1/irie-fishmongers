import { Injectable } from '@nestjs/common';
import {
  ObligationStatus,
  PaymentObligationDirection,
  Prisma,
  SettlementChannel,
  WeightAdjustmentObligation,
  WeightAdjustmentSettlementRecord,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import {
  RecordObligationInput,
  RecordSettlementEvidenceInput,
} from './types/weight-adjustment-repository.types';
import { computeCanonicalPayloadHash } from './utils/canonical-hash.util';
import {
  AdjustmentNotFoundError,
  IdempotencyPayloadConflictError,
  ImmutableAuditMutationError,
  InvalidSettlementAmountError,
  InvalidSettlementChannelError,
  ObligationAlreadySettledError,
  SettlementAmountExceedsObligationError,
  SettlementChannelDirectionMismatchError,
  WeightAdjustmentRepositoryError,
} from './errors/weight-adjustment-repository.errors';

/**
 * Permitted settlement channels by obligation direction.
 * - CREDIT_DUE_CUSTOMER: Prohibits customer-to-platform payment channels. Only store credit memo is permitted.
 * - SUPPLEMENTAL_PAYMENT_DUE: Prohibits credit memos as customer payment. Permits COD, WiPay, or vendor absorption.
 * - NONE: Prohibits any settlement since no financial obligation exists.
 */
export const PERMITTED_SETTLEMENT_CHANNELS_BY_DIRECTION: Record<
  PaymentObligationDirection,
  readonly SettlementChannel[]
> = {
  [PaymentObligationDirection.CREDIT_DUE_CUSTOMER]: [
    SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
  ],
  [PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE]: [
    SettlementChannel.COD_DOORSTEP_RECEIPT,
    SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
    SettlementChannel.VENDOR_ABSORPTION,
  ],
  [PaymentObligationDirection.NONE]: [],
};

/**
 * Financial evidence classification semantics.
 * Distinguishes verified customer money received, customer credit memo issuance, and vendor write-offs/waivers.
 */
export enum FinancialEvidenceClassification {
  CUSTOMER_PAYMENT = 'CUSTOMER_PAYMENT',
  CUSTOMER_CREDIT_MEMO = 'CUSTOMER_CREDIT_MEMO',
  VENDOR_ABSORPTION_WAIVER = 'VENDOR_ABSORPTION_WAIVER',
}

export function classifySettlementEvidence(
  channel: SettlementChannel,
): FinancialEvidenceClassification {
  switch (channel) {
    case SettlementChannel.COD_DOORSTEP_RECEIPT:
    case SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED:
      return FinancialEvidenceClassification.CUSTOMER_PAYMENT;
    case SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED:
      return FinancialEvidenceClassification.CUSTOMER_CREDIT_MEMO;
    case SettlementChannel.VENDOR_ABSORPTION:
      return FinancialEvidenceClassification.VENDOR_ABSORPTION_WAIVER;
    default:
      throw new InvalidSettlementChannelError(channel);
  }
}

@Injectable()
export class WeightFinancialObligationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Classifies settlement channel into strict accounting evidence semantics.
   */
  classifySettlementRecord(channel: SettlementChannel): FinancialEvidenceClassification {
    return classifySettlementEvidence(channel);
  }

  /**
   * Records an immutable financial obligation resulting from a weight calculation.
   */
  async recordObligation(
    input: RecordObligationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ obligation: WeightAdjustmentObligation; isReplay: boolean }> {
    const payloadForHashing = {
      weightAdjustmentId: input.weightAdjustmentId,
      revision: input.revision,
      direction: input.direction,
      amountJmd: new Decimal(input.amountJmd).toFixed(2),
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    const client = tx ?? this.prisma;
    const existing = await client.weightAdjustmentObligation.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });

    if (existing) {
      if (existing.payloadHash === payloadHash) {
        return { obligation: existing, isReplay: true };
      }
      throw new IdempotencyPayloadConflictError(
        input.idempotencyKey,
        existing.payloadHash,
        payloadHash,
      );
    }

    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      const obligation = await txClient.weightAdjustmentObligation.create({
        data: {
          weightAdjustmentId: input.weightAdjustmentId,
          revision: input.revision,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          direction: input.direction,
          amountJmd: new Prisma.Decimal(new Decimal(input.amountJmd).toFixed(2)),
          status: input.status ?? ObligationStatus.PENDING,
        },
      });
      return { obligation, isReplay: false };
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      } else {
        return await this.prisma.$transaction(executeInTransaction);
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const recovered = await this.prisma.weightAdjustmentObligation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (recovered) {
          if (recovered.payloadHash === payloadHash) {
            return { obligation: recovered, isReplay: true };
          }
          throw new IdempotencyPayloadConflictError(
            input.idempotencyKey,
            recovered.payloadHash,
            payloadHash,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Records physical settlement evidence toward a financial obligation.
   * - Prohibits marking an obligation settled without verifiable evidence.
   * - Enforces direction-specific settlement channels (F-16D-WP2-P1-04).
   * - Rejects zero, negative, or excessive settlement amounts.
   * - Locks the obligation row to protect against concurrent settlement races.
   * - Leaves partial settlements PENDING with accurate cumulative balances.
   * - Transitions to SETTLED only upon exact full cumulative discharge.
   * - Rejects new settlements against an already settled obligation while preserving idempotent replays.
   */
  async recordSettlementEvidence(
    input: RecordSettlementEvidenceInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ settlement: WeightAdjustmentSettlementRecord; isReplay: boolean }> {
    // 1. Validate permitted settlement channels
    const allValidChannels = Object.values(SettlementChannel);
    if (!allValidChannels.includes(input.settlementChannel)) {
      throw new InvalidSettlementChannelError(input.settlementChannel);
    }

    // 2. Validate settlement amount is strictly positive and finite
    let incomingAmount: Decimal;
    try {
      incomingAmount = new Decimal(input.amountSettled);
    } catch {
      throw new InvalidSettlementAmountError(
        `Settlement amount "${input.amountSettled}" is not a valid decimal number.`,
      );
    }
    if (!incomingAmount.isFinite() || incomingAmount.lessThanOrEqualTo(0)) {
      throw new InvalidSettlementAmountError(
        `Settlement amount must be strictly positive: received "${input.amountSettled}". Zero or negative settlements are rejected.`,
      );
    }

    // 3. Compute canonical idempotency hash
    const payloadForHashing = {
      obligationId: input.obligationId,
      settlementChannel: input.settlementChannel,
      amountSettled: incomingAmount.toFixed(2),
      externalReference: input.externalReference ?? null,
      settledByUserId: input.settledByUserId,
    };
    const payloadHash = computeCanonicalPayloadHash(payloadForHashing);

    // 4. Check for existing settlement record (idempotency check outside/before tx)
    const client = tx ?? this.prisma;
    const existing = await client.weightAdjustmentSettlementRecord.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });

    if (existing) {
      if (existing.payloadHash === payloadHash) {
        return { settlement: existing, isReplay: true };
      }
      throw new IdempotencyPayloadConflictError(
        input.idempotencyKey,
        existing.payloadHash,
        payloadHash,
      );
    }

    // 5. Encapsulate execution inside interactive transaction
    const executeInTransaction = async (txClient: Prisma.TransactionClient) => {
      // Concurrency protection: row-level lock on obligation in PostgreSQL if supported
      if (typeof (txClient as any).$queryRaw === 'function') {
        await txClient.$queryRaw`SELECT id FROM weight_adjustment_obligations WHERE id = ${input.obligationId} FOR UPDATE;`;
      }

      // Fetch parent obligation with all existing settlement records
      const obligation = await txClient.weightAdjustmentObligation.findUnique({
        where: { id: input.obligationId },
        include: {
          settlementRecords: {
            select: { amountSettled: true },
            orderBy: { settledAt: 'asc' },
          },
        },
      });

      if (!obligation) {
        throw new AdjustmentNotFoundError(`Obligation ID "${input.obligationId}"`);
      }

      // Direction-specific settlement channel enforcement
      const permittedChannels =
        PERMITTED_SETTLEMENT_CHANNELS_BY_DIRECTION[obligation.direction] ?? [];
      if (!permittedChannels.includes(input.settlementChannel)) {
        throw new SettlementChannelDirectionMismatchError(
          input.settlementChannel,
          obligation.direction,
        );
      }

      // Prohibit additional settlements if obligation is already marked SETTLED, WAIVED, or DISPUTED
      if (obligation.status === ObligationStatus.SETTLED) {
        throw new ObligationAlreadySettledError(obligation.id);
      }
      if (obligation.status === ObligationStatus.WAIVED) {
        throw new WeightAdjustmentRepositoryError(
          `Obligation "${obligation.id}" has been waived and cannot be settled.`,
        );
      }
      if (obligation.status === ObligationStatus.DISPUTED) {
        throw new WeightAdjustmentRepositoryError(
          `Obligation "${obligation.id}" is disputed and cannot be settled until resolved.`,
        );
      }

      // Calculate cumulative settled amount and outstanding balance with Decimal arithmetic
      const totalObligation = new Decimal(obligation.amountJmd.toString());
      const totalSettledSoFar = (obligation.settlementRecords ?? []).reduce(
        (sum, record) => sum.plus(new Decimal(record.amountSettled.toString())),
        new Decimal(0),
      );
      const remainingBalance = totalObligation.minus(totalSettledSoFar);

      if (remainingBalance.lessThanOrEqualTo(0)) {
        throw new ObligationAlreadySettledError(obligation.id);
      }

      // Reject settlement amounts that exceed the remaining balance
      if (incomingAmount.greaterThan(remainingBalance)) {
        throw new SettlementAmountExceedsObligationError(
          obligation.id,
          incomingAmount.toFixed(2),
          remainingBalance.toFixed(2),
        );
      }

      // Insert immutable evidence record
      const settlement = await txClient.weightAdjustmentSettlementRecord.create({
        data: {
          obligationId: input.obligationId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          settlementChannel: input.settlementChannel,
          amountSettled: new Prisma.Decimal(incomingAmount.toFixed(2)),
          externalReference: input.externalReference,
          evidenceDocumentUrl: input.evidenceDocumentUrl,
          settledByUserId: input.settledByUserId,
        },
      });

      // Transition obligation status to SETTLED only upon exact full discharge
      const newTotalSettled = totalSettledSoFar.plus(incomingAmount);
      if (newTotalSettled.equals(totalObligation)) {
        await txClient.weightAdjustmentObligation.update({
          where: { id: input.obligationId },
          data: { status: ObligationStatus.SETTLED },
        });
      }

      return { settlement, isReplay: false };
    };

    try {
      if (tx) {
        return await executeInTransaction(tx);
      } else {
        return await this.prisma.$transaction(executeInTransaction);
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const recovered = await this.prisma.weightAdjustmentSettlementRecord.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (recovered) {
          if (recovered.payloadHash === payloadHash) {
            return { settlement: recovered, isReplay: true };
          }
          throw new IdempotencyPayloadConflictError(
            input.idempotencyKey,
            recovered.payloadHash,
            payloadHash,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves accurate outstanding balance and discharge status for an obligation.
   */
  async getObligationBalance(
    obligationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    obligationId: string;
    totalAmountJmd: string;
    totalSettledJmd: string;
    remainingBalanceJmd: string;
    status: ObligationStatus;
    isFullySettled: boolean;
  }> {
    const client = tx ?? this.prisma;
    const obligation = await client.weightAdjustmentObligation.findUnique({
      where: { id: obligationId },
      include: {
        settlementRecords: {
          select: { amountSettled: true },
        },
      },
    });

    if (!obligation) {
      throw new AdjustmentNotFoundError(`Obligation ID "${obligationId}"`);
    }

    const total = new Decimal(obligation.amountJmd.toString());
    const settled = (obligation.settlementRecords ?? []).reduce(
      (sum, r) => sum.plus(new Decimal(r.amountSettled.toString())),
      new Decimal(0),
    );
    const remaining = Decimal.max(0, total.minus(settled));

    return {
      obligationId: obligation.id,
      totalAmountJmd: total.toFixed(2),
      totalSettledJmd: settled.toFixed(2),
      remainingBalanceJmd: remaining.toFixed(2),
      status: obligation.status,
      isFullySettled: settled.greaterThanOrEqualTo(total),
    };
  }

  async findObligationsByAdjustmentId(
    weightAdjustmentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WeightAdjustmentObligation[]> {
    const client = tx ?? this.prisma;
    return client.weightAdjustmentObligation.findMany({
      where: { weightAdjustmentId },
      include: { settlementRecords: { orderBy: { settledAt: 'asc' } } },
      orderBy: { revision: 'asc' },
    });
  }

  update(): never {
    throw new ImmutableAuditMutationError('WeightAdjustmentObligation / SettlementRecord', 'CANNOT_UPDATE');
  }

  delete(): never {
    throw new ImmutableAuditMutationError('WeightAdjustmentObligation / SettlementRecord', 'CANNOT_DELETE');
  }
}
